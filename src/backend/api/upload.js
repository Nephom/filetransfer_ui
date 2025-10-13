/**
 * File Upload API Endpoints
 * Handles file upload operations with progress tracking
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const { transferManager } = require('../transfer');
const { FileSystem } = require('../file-system');
const { systemLogger } = require('../utils/logger');

class UploadAPI {
  constructor() {
    this.router = express.Router();
    this.fileSystem = new FileSystem();
    this._setupMiddleware();
    this._setupRoutes();
  }

  /**
   * Setup multer storage configuration
   * @private
   */
  _setupMiddleware() {
    const fs = require('fs');
    const path = require('path');
    
    // Ensure temp upload directory exists
    const tempDir = './temp';
    const uploadsDir = './temp/uploads';
    
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    
    // Configure multer for file uploads
    const storage = multer.diskStorage({
      destination: (req, file, cb) => {
        // Use a temporary directory for uploads
        cb(null, uploadsDir);
      },
      filename: (req, file, cb) => {
        // Generate unique filename
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
      }
    });

    this.upload = multer({
      storage: storage,
      // No file size limit
      fileFilter: (req, file, cb) => {
        // Allow all file types for now
        cb(null, true);
      }
    });
  }

  /**
   * Setup API routes
   * @private
   */
  _setupRoutes() {
    // Main upload endpoint that handles files field (used by frontend)
    // Use .fields() to accept both 'files' and 'filePaths[]' for folder uploads
    this.router.post('/upload', this.upload.fields([
      { name: 'files', maxCount: 1000 },
      { name: 'filePaths[]', maxCount: 1000 }
    ]), (req, res) => {
      // Normalize files array for folder uploads
      if (req.files && req.files.files) {
        req.files = req.files.files;
      }
      // Simplified: _handleMultipleUpload can handle one or many files
      this._handleMultipleUpload(req, res);
    });

    // Alternative endpoint for single file upload with 'file' field
    this.router.post('/upload/single', this.upload.single('file'), (req, res) => {
      this._handleSingleUpload(req, res);
    });

    // Alternative endpoint for multiple file upload with 'files' field
    this.router.post('/upload/multiple', this.upload.fields([
      { name: 'files', maxCount: 1000 },
      { name: 'filePaths[]', maxCount: 1000 }
    ]), (req, res) => {
      // Normalize files array for folder uploads
      if (req.files && req.files.files) {
        req.files = req.files.files;
      }
      this._handleMultipleUpload(req, res);
    });

    // Upload with progress tracking
    this.router.post('/upload/progress', this.upload.single('file'), (req, res) => {
      this._handleUploadWithProgress(req, res);
    });

    // New single-file progress upload endpoint (uses Busboy, no multer)
    this.router.post('/upload/single-progress', (req, res) => {
      this._handleSingleProgressUpload(req, res);
    });
  }

  /**
   * Handle single file upload
   * @private
   */
  async _handleSingleUpload(req, res) {
    try {
      // Manual authentication check for multipart requests
      const jwt = require('jsonwebtoken');
      const configManager = require('../config');
      const jwtSecret = configManager.get('security.jwtSecret') || 'file-transfer-secret-key';
      
      // Try to get token from header first
      let token = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
      
      // If not in header, try to get from body (for multipart)
      if (!token && req.body && req.body.token) {
        token = req.body.token;
      }
      
      if (!token) {
        return res.status(401).json({
          error: 'Authorization token missing'
        });
      }
      
      try {
        const decoded = jwt.verify(token, jwtSecret);
        req.user = decoded; // Attach user info to request
      } catch (authError) {
        return res.status(401).json({
          error: 'Invalid or expired token'
        });
      }
      
      if (!req.file) {
        return res.status(400).json({
          error: 'No file uploaded'
        });
      }

      // Get currentPath from request body to determine destination directory
      const currentPath = req.body.path || '';
      const storagePath = configManager.get('fileSystem.storagePath') || './storage';
      
      // Build final path in storage directory
      let finalDir;
      if (currentPath) {
        // Join storage path with currentPath, ensuring no directory traversal
        finalDir = path.join(storagePath, currentPath);
      } else {
        finalDir = storagePath;
      }
      
      // Ensure the destination path is within the storage directory
      const normalizedFinalDir = path.resolve(finalDir);
      const normalizedStoragePath = path.resolve(storagePath);
      
      if (!normalizedFinalDir.startsWith(normalizedStoragePath)) {
        return res.status(403).json({
          error: 'Forbidden: Access denied.'
        });
      }
      
      // Create directory if it doesn't exist
      await this.fileSystem.mkdir(normalizedFinalDir);
      
      // Final file path
      const finalPath = path.join(normalizedFinalDir, path.basename(req.file.originalname));

      // Create transfer record
      const transferId = transferManager.startTransfer({
        source: req.file.path,
        destination: finalPath,
        totalSize: req.file.size
      });

      // Move file to final destination in storage
      await this.fileSystem.move(req.file.path, finalPath);

      // Update transfer as complete
      transferManager.completeTransfer(transferId, {
        result: 'success',
        file: {
          name: path.basename(req.file.originalname),
          path: finalPath,
          size: req.file.size
        }
      });

      res.json({
        success: true,
        transferId,
        message: 'File uploaded successfully',
        file: {
          name: path.basename(req.file.originalname),
          path: finalPath,
          size: req.file.size
        }
      });
    } catch (error) {
      systemLogger.logError(`Upload failed: ${error.message}`, req);
      res.status(500).json({
        error: 'Upload failed',
        message: error.message
      });
    }
  }

  /**
   * Handle multiple file uploads with batch tracking
   * @private
   */
  async _handleMultipleUpload(req, res) {
    try {
      // Manual authentication check for multipart requests
      const jwt = require('jsonwebtoken');
      const configManager = require('../config');
      const jwtSecret = configManager.get('security.jwtSecret') || 'file-transfer-secret-key';

      // Try to get token from header first
      let token = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }

      // If not in header, try to get from body (for multipart)
      if (!token && req.body && req.body.token) {
        token = req.body.token;
      }

      if (!token) {
        return res.status(401).json({
          error: 'Authorization token missing'
        });
      }

      try {
        const decoded = jwt.verify(token, jwtSecret);
        req.user = decoded; // Attach user info to request
      } catch (authError) {
        return res.status(401).json({
          error: 'Invalid or expired token'
        });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          error: 'No files uploaded'
        });
      }

      // Get currentPath from request body to determine destination directory
      const currentPath = req.body.path || '';
      const storagePath = configManager.get('fileSystem.storagePath') || './storage';

      // Build final path in storage directory
      let finalDir;
      if (currentPath) {
        // Join storage path with currentPath, ensuring no directory traversal
        finalDir = path.join(storagePath, currentPath);
      } else {
        finalDir = storagePath;
      }

      // Ensure the destination path is within the storage directory
      const normalizedFinalDir = path.resolve(finalDir);
      const normalizedStoragePath = path.resolve(storagePath);

      if (!normalizedFinalDir.startsWith(normalizedStoragePath)) {
        return res.status(403).json({
          error: 'Forbidden: Access denied.'
        });
      }

      // 1. Create batch for this multi-file upload
      const batchId = transferManager.createBatch({
        totalFiles: req.files.length
      });

      // 2. Immediately respond with 202 Accepted and batchId
      res.status(202).json({
        success: true,
        batchId,
        message: 'Batch upload initiated. Poll for batch progress.'
      });

      // 3. Process files in background
      this._processFilesInBackground(req.files, batchId, {
        currentPath,
        normalizedFinalDir,
        normalizedStoragePath,
        filePaths: req.body.filePaths || [],
        user: req.user
      });

    } catch (error) {
      systemLogger.logError(`Upload failed: ${error.message}`, req);

      // If response hasn't been sent yet
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Upload failed',
          message: error.message
        });
      }
    }
  }

  /**
   * Process multiple files in background and update batch progress
   * @param {Array} files - Array of uploaded files from multer
   * @param {string} batchId - Batch ID
   * @param {Object} metadata - Upload metadata (paths, user info, etc.)
   * @private
   */
  async _processFilesInBackground(files, batchId, metadata) {
    const { normalizedFinalDir, normalizedStoragePath, filePaths, user } = metadata;
    const hasFolderStructure = Array.isArray(filePaths) && filePaths.length > 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      let transferId = null;

      try {
        // Determine final file path
        let finalPath;
        if (hasFolderStructure && filePaths[i]) {
          // Use the relative path to preserve folder structure
          const relativePath = filePaths[i];
          finalPath = path.join(normalizedFinalDir, relativePath);

          // Ensure the parent directory exists
          const parentDir = path.dirname(finalPath);
          await this.fileSystem.mkdir(parentDir);
        } else {
          // Just use the filename
          finalPath = path.join(normalizedFinalDir, path.basename(file.originalname));
        }

        // Ensure the destination path is still within the storage directory
        const normalizedFinalPath = path.resolve(finalPath);
        if (!normalizedFinalPath.startsWith(normalizedStoragePath)) {
          systemLogger.logError(`Security: Attempted path traversal with path: ${finalPath}`, { user });

          // Create a failed transfer for this file
          transferId = transferManager.startTransfer({
            fileName: path.basename(file.originalname),
            source: file.path,
            destination: finalPath,
            totalSize: file.size,
            batchId,
            status: 'failed'
          });

          transferManager.failTransfer(transferId, {
            code: 403,
            message: 'Path traversal attempt',
            details: `Invalid path: ${finalPath}`
          });

          transferManager.addTransferToBatch(batchId, transferId);
          continue; // Skip this file
        }

        // Create directory if it doesn't exist
        await this.fileSystem.mkdir(normalizedFinalDir);

        // Create transfer record
        transferId = transferManager.startTransfer({
          fileName: path.basename(file.originalname),
          source: file.path,
          destination: normalizedFinalPath,
          totalSize: file.size,
          batchId,
          status: 'pending'
        });

        // Add transfer to batch
        transferManager.addTransferToBatch(batchId, transferId);

        // Update status to processing
        transferManager.updateTransferStatus(transferId, 'processing');

        // Move file to final destination in storage
        await this.fileSystem.move(file.path, normalizedFinalPath);

        // Update transfer as complete
        transferManager.completeTransfer(transferId, {
          result: 'success',
          file: {
            name: path.basename(file.originalname),
            path: normalizedFinalPath,
            size: file.size
          }
        });

        // Log successful upload
        systemLogger.logFileOperation('upload', path.basename(file.originalname), true, { user }, {
          transferId,
          batchId,
          size: file.size
        });

      } catch (error) {
        // If transfer was created, mark it as failed
        if (transferId) {
          transferManager.failTransfer(transferId, {
            code: 500,
            message: 'File processing failed',
            details: error.message
          });
        } else {
          // Create a failed transfer record
          transferId = transferManager.startTransfer({
            fileName: path.basename(file.originalname),
            source: file.path,
            totalSize: file.size,
            batchId,
            status: 'failed'
          });

          transferManager.addTransferToBatch(batchId, transferId);

          transferManager.failTransfer(transferId, {
            code: 500,
            message: 'File processing failed',
            details: error.message
          });
        }

        // Log failed upload
        systemLogger.logFileOperation('upload', path.basename(file.originalname), false, { user }, {
          transferId,
          batchId,
          error: error.message
        });
      }

      // Update batch progress after each file
      transferManager.updateBatchProgress(batchId);
    }

    // Final batch update
    transferManager.updateBatchProgress(batchId);

    systemLogger.logSystem('INFO', `Batch ${batchId} processing completed`);
  }

  /**
   * Handle upload with progress tracking
   * @private
   */
  async _handleUploadWithProgress(req, res) {
    try {
      // Manual authentication check for multipart requests
      const jwt = require('jsonwebtoken');
      const configManager = require('../config');
      const jwtSecret = configManager.get('security.jwtSecret') || 'file-transfer-secret-key';
      
      // Try to get token from header first
      let token = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
      
      // If not in header, try to get from body (for multipart)
      if (!token && req.body && req.body.token) {
        token = req.body.token;
      }
      
      if (!token) {
        return res.status(401).json({
          error: 'Authorization token missing'
        });
      }
      
      try {
        const decoded = jwt.verify(token, jwtSecret);
        req.user = decoded; // Attach user info to request
      } catch (authError) {
        return res.status(401).json({
          error: 'Invalid or expired token'
        });
      }
      
      if (!req.file) {
        return res.status(400).json({
          error: 'No file uploaded'
        });
      }

      // Get currentPath from request body to determine destination directory
      const currentPath = req.body.path || '';
      const storagePath = configManager.get('fileSystem.storagePath') || './storage';
      
      // Build final path in storage directory
      let finalDir;
      if (currentPath) {
        // Join storage path with currentPath, ensuring no directory traversal
        finalDir = path.join(storagePath, currentPath);
      } else {
        finalDir = storagePath;
      }
      
      // Ensure the destination path is within the storage directory
      const normalizedFinalDir = path.resolve(finalDir);
      const normalizedStoragePath = path.resolve(storagePath);
      
      if (!normalizedFinalDir.startsWith(normalizedStoragePath)) {
        return res.status(403).json({
          error: 'Forbidden: Access denied.'
        });
      }
      
      // Create directory if it doesn't exist
      await this.fileSystem.mkdir(normalizedFinalDir);
      
      // Final file path
      const finalPath = path.join(normalizedFinalDir, path.basename(req.file.originalname));

      // Create transfer record
      const transferId = transferManager.startTransfer({
        source: req.file.path,
        destination: finalPath,
        totalSize: req.file.size
      });

      // Simulate progress updates (in real implementation, this would happen during file write)
      let progress = 0;
      const interval = setInterval(() => {
        progress += 10;
        if (progress >= 100) {
          clearInterval(interval);
        }

        // Update progress
        transferManager.updateProgress(transferId, Math.min(progress * req.file.size / 100, req.file.size));
      }, 200);

      // Simulate completion
      setTimeout(async () => {
        clearInterval(interval);

        // Move file to final destination in storage
        await this.fileSystem.move(req.file.path, finalPath);

        // Update transfer as complete
        transferManager.completeTransfer(transferId, {
          result: 'success',
          file: {
            name: path.basename(req.file.originalname),
            path: finalPath,
            size: req.file.size
          }
        });

        // Send response when done
        res.json({
          success: true,
          transferId,
          message: 'File uploaded successfully with progress tracking',
          file: {
            name: path.basename(req.file.originalname),
            path: finalPath,
            size: req.file.size
          }
        });
      }, 2000);
    } catch (error) {
      systemLogger.logError(`Upload failed: ${error.message}`, req);
      res.status(500).json({
        error: 'Upload failed',
        message: error.message
      });
    }
  }

  /**
   * Handle single file upload with real-time progress tracking using Busboy
   * @param {Object} req - Express request
   * @param {Object} res - Express response
   * @private
   */
  async _handleSingleProgressUpload(req, res) {
    const Busboy = require('busboy');
    const fs = require('fs');

    try {
      // 1. Manual JWT authentication (since we're not using multer middleware)
      const jwt = require('jsonwebtoken');
      const configManager = require('../config');
      const jwtSecret = configManager.get('security.jwtSecret') || 'file-transfer-secret-key';

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
          success: false,
          error: {
            code: 401,
            message: 'Missing or invalid authorization token'
          }
        });
      }

      const token = authHeader.substring(7);
      try {
        const decoded = jwt.verify(token, jwtSecret);
        req.user = decoded;
      } catch (authError) {
        return res.status(401).json({
          success: false,
          error: {
            code: 401,
            message: 'Invalid or expired token'
          }
        });
      }

      // 2. Validate Content-Length header
      const contentLength = parseInt(req.headers['content-length']);
      if (!contentLength || contentLength === 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: 301,
            message: '檔案Content-Length不完整',
            details: 'Content-Length header is required and must be greater than 0'
          }
        });
      }

      // 3. Get filename and path from query parameters
      const fileName = req.query.fileName;
      const uploadPath = req.query.path || '';

      if (!fileName) {
        return res.status(400).json({
          success: false,
          error: {
            code: 304,
            message: '檔案名稱缺失',
            details: 'fileName query parameter is required'
          }
        });
      }

      // 4. Sanitize filename (UTF-8 encoding, remove path traversal)
      let sanitizedFileName;
      try {
        sanitizedFileName = this._sanitizeFilename(fileName);
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error
        });
      }

      // 5. Determine destination path
      const storagePath = configManager.get('fileSystem.storagePath') || './storage';
      const storageRoot = path.resolve(storagePath);
      const targetDir = uploadPath ? path.join(storageRoot, uploadPath) : storageRoot;
      const finalPath = path.join(targetDir, sanitizedFileName);

      // Security check: ensure path is within storage root
      if (!finalPath.startsWith(storageRoot)) {
        return res.status(403).json({
          success: false,
          error: {
            code: 403,
            message: 'Forbidden: Access denied'
          }
        });
      }

      // 6. Create transfer ID and initialize transfer
      const transferId = transferManager.startTransfer({
        fileName: sanitizedFileName,
        totalSize: contentLength,
        destination: finalPath,
        status: 'pending'
      });

      // 7. Immediately respond with 202 Accepted
      res.status(202).json({
        success: true,
        transferId,
        message: 'Upload initiated. Poll for progress.'
      });

      // 8. Initialize Busboy
      const busboy = Busboy({
        headers: req.headers,
        limits: {
          files: 1, // Only accept single file
          fileSize: configManager.get('fileSystem.maxFileSize') || Infinity
        }
      });

      let fileProcessed = false;
      let uploadedBytes = 0;

      // 9. Listen to 'file' event (when a file field is encountered)
      busboy.on('file', async (fieldname, fileStream, info) => {
        const { filename, encoding, mimeType } = info;

        if (fileProcessed) {
          fileStream.resume(); // Discard additional files
          return;
        }
        fileProcessed = true;

        // Update status to 'uploading'
        transferManager.updateTransferStatus(transferId, 'uploading');

        // Create destination directory if it doesn't exist
        await this.fileSystem.mkdir(targetDir);

        // Create write stream to destination
        const writeStream = fs.createWriteStream(finalPath);

        // Track upload progress
        fileStream.on('data', (chunk) => {
          uploadedBytes += chunk.length;

          // Update transfer progress in real-time
          transferManager.updateProgress(transferId, uploadedBytes, contentLength);
        });

        // Pipe file stream to write stream
        fileStream.pipe(writeStream);

        // Handle write stream completion
        writeStream.on('finish', () => {
          transferManager.completeTransfer(transferId, {
            result: 'success',
            file: {
              name: sanitizedFileName,
              path: finalPath,
              size: uploadedBytes
            }
          });
          systemLogger.logFileOperation('upload', sanitizedFileName, true, req, {
            transferId,
            size: uploadedBytes
          });
        });

        // Handle write stream errors
        writeStream.on('error', (err) => {
          // Check for disk space error
          if (err.code === 'ENOSPC') {
            transferManager.failTransfer(transferId, {
              code: 401,
              message: '服務端磁碟空間已滿，請洽管理員',
              details: err.message
            });
          } else {
            transferManager.failTransfer(transferId, {
              code: 500,
              message: '檔案寫入失敗',
              details: err.message
            });
          }

          // Clean up partial file
          fs.unlink(finalPath, () => {});

          systemLogger.logFileOperation('upload', sanitizedFileName, false, req, {
            transferId,
            error: err.message
          });
        });

        // Handle file stream errors (upload interruption)
        fileStream.on('error', (err) => {
          transferManager.failTransfer(transferId, {
            code: 302,
            message: '檔案上傳中斷',
            details: err.message
          });

          // Clean up partial file
          writeStream.destroy();
          fs.unlink(finalPath, () => {});

          systemLogger.logFileOperation('upload', sanitizedFileName, false, req, {
            transferId,
            error: 'Upload interrupted'
          });
        });
      });

      // 10. Handle file size limit exceeded
      busboy.on('limit', () => {
        transferManager.failTransfer(transferId, {
          code: 413,
          message: '檔案大小超過限制',
          details: `Maximum file size: ${configManager.get('fileSystem.maxFileSize')} bytes`
        });
      });

      // 11. Handle busboy errors
      busboy.on('error', (err) => {
        transferManager.failTransfer(transferId, {
          code: 500,
          message: '上傳處理錯誤',
          details: err.message
        });
      });

      // 12. Handle request close/abort (client disconnected)
      req.on('close', () => {
        const transfer = transferManager.getTransfer(transferId);
        if (transfer && transfer.status === 'uploading') {
          transferManager.failTransfer(transferId, {
            code: 302,
            message: '檔案上傳中斷',
            details: 'Client disconnected'
          });

          // Clean up partial file
          fs.unlink(finalPath, () => {});
        }
      });

      // 13. Pipe request to busboy
      req.pipe(busboy);

    } catch (error) {
      systemLogger.logSystem('ERROR', `Upload error: ${error.message}`);

      // If response hasn't been sent yet
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: {
            code: 500,
            message: 'Internal server error',
            details: error.message
          }
        });
      }
    }
  }

  /**
   * Get upload progress for a transfer
   * @param {string} transferId - Transfer ID
   * @returns {Object} Progress information
   */
  getUploadProgress(transferId) {
    return transferManager.getTransfer(transferId);
  }

  /**
   * Get all uploads
   * @returns {Array} Array of all transfers
   */
  getAllUploads() {
    return transferManager.getAllTransfers();
  }

  /**
   * Sanitize filename for safe file system operations
   * @param {string} filename - Raw filename from client
   * @returns {string} Sanitized filename
   * @private
   */
  _sanitizeFilename(filename) {
    // Decode URL encoding
    let decoded = decodeURIComponent(filename);

    // Ensure UTF-8 encoding
    decoded = Buffer.from(decoded, 'utf8').toString('utf8');

    // Remove path traversal characters
    decoded = decoded.replace(/[\/\\]/g, '_').replace(/\.\./g, '_');

    // Validate no illegal characters (Windows/Linux compatible)
    if (/[<>:"|?*\x00-\x1F]/.test(decoded)) {
      const error = {
        code: 304,
        message: '檔案名稱包含非法字元',
        details: `Invalid filename: ${filename}`
      };
      throw error;
    }

    return decoded;
  }

  /**
   * Get router instance
   */
  getRouter() {
    return this.router;
  }
}

module.exports = UploadAPI;

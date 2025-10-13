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
    // Multer error handler middleware
    const handleMulterError = (err, req, res, next) => {
      // If no error, continue to next middleware
      if (!err) {
        return next();
      }

      systemLogger.logSystem('ERROR', `❌ Upload error occurred`);
      systemLogger.logSystem('ERROR', `Error message: ${err.message}`);
      systemLogger.logSystem('ERROR', `Error code: ${err.code}`);
      systemLogger.logSystem('ERROR', `Error field: ${err.field}`);
      systemLogger.logSystem('ERROR', `Error stack: ${err.stack}`);

      // Handle multer-specific errors
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          success: false,
          error: {
            code: 413,
            message: '檔案大小超過限制',
            details: err.message
          }
        });
      }

      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({
          success: false,
          error: {
            code: 400,
            message: '檔案數量超過限制',
            details: err.message
          }
        });
      }

      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({
          success: false,
          error: {
            code: 400,
            message: '未預期的檔案欄位',
            details: err.message
          }
        });
      }

      // Handle file system errors
      if (err.code === 'ENOENT') {
        return res.status(404).json({
          success: false,
          error: {
            code: 404,
            message: '目標路徑不存在',
            details: err.message
          }
        });
      }

      if (err.code === 'EACCES' || err.code === 'EPERM') {
        return res.status(403).json({
          success: false,
          error: {
            code: 403,
            message: '權限不足，無法存取檔案',
            details: err.message
          }
        });
      }

      if (err.code === 'ENOSPC') {
        return res.status(507).json({
          success: false,
          error: {
            code: 507,
            message: '磁碟空間不足',
            details: err.message
          }
        });
      }

      // Generic error
      systemLogger.logSystem('ERROR', `❌ Unhandled upload error type: ${err.constructor.name}`);
      return res.status(500).json({
        success: false,
        error: {
          code: 500,
          message: '檔案上傳錯誤',
          details: err.message
        }
      });
    };

    // Main upload endpoint that handles files field (used by frontend)
    // Use .fields() to accept both 'files' and 'filePaths[]' for folder uploads
    this.router.post('/upload',
      this.upload.fields([
        { name: 'files', maxCount: 1000 },
        { name: 'filePaths[]', maxCount: 1000 }
      ]),
      handleMulterError,
      (req, res) => {
        // Normalize files array for folder uploads
        if (req.files && req.files.files) {
          req.files = req.files.files;
        }
        // Simplified: _handleMultipleUpload can handle one or many files
        this._handleMultipleUpload(req, res);
      }
    );

    // Alternative endpoint for single file upload with 'file' field
    this.router.post('/upload/single',
      this.upload.single('file'),
      handleMulterError,
      (req, res) => {
        this._handleSingleUpload(req, res);
      }
    );

    // Alternative endpoint for multiple file upload with 'files' field
    this.router.post('/upload/multiple',
      this.upload.fields([
        { name: 'files', maxCount: 1000 },
        { name: 'filePaths[]', maxCount: 1000 }
      ]),
      handleMulterError,
      (req, res) => {
        // Normalize files array for folder uploads
        if (req.files && req.files.files) {
          req.files = req.files.files;
        }
        this._handleMultipleUpload(req, res);
      }
    );

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
      systemLogger.logSystem('INFO', `📥 [BATCH UPLOAD START] Multi-file upload initiated`);
      systemLogger.logSystem('INFO', `Headers: ${JSON.stringify(req.headers)}`);
      systemLogger.logSystem('INFO', `Body keys: ${Object.keys(req.body).join(', ')}`);
      systemLogger.logSystem('INFO', `Files object type: ${typeof req.files}`);
      systemLogger.logSystem('INFO', `Files object keys: ${req.files ? Object.keys(req.files).join(', ') : 'null'}`);

      // Manual authentication check for multipart requests
      const jwt = require('jsonwebtoken');
      const configManager = require('../config');
      const jwtSecret = configManager.get('security.jwtSecret') || 'file-transfer-secret-key';

      systemLogger.logSystem('INFO', `[BATCH] Step 1: Checking authentication`);

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
        systemLogger.logSystem('ERROR', `[BATCH] Authorization token missing`);
        return res.status(401).json({
          error: 'Authorization token missing'
        });
      }

      try {
        const decoded = jwt.verify(token, jwtSecret);
        req.user = decoded; // Attach user info to request
        systemLogger.logSystem('INFO', `[BATCH] Step 1: Authentication successful for user: ${decoded.username}`);
      } catch (authError) {
        systemLogger.logSystem('ERROR', `[BATCH] JWT verification failed: ${authError.message}`);
        return res.status(401).json({
          error: 'Invalid or expired token'
        });
      }

      systemLogger.logSystem('INFO', `[BATCH] Step 2: Validating files`);
      systemLogger.logSystem('INFO', `[BATCH] req.files type: ${typeof req.files}`);
      systemLogger.logSystem('INFO', `[BATCH] req.files is array: ${Array.isArray(req.files)}`);
      systemLogger.logSystem('INFO', `[BATCH] req.files length: ${req.files ? req.files.length : 'undefined'}`);

      if (!req.files || req.files.length === 0) {
        systemLogger.logSystem('ERROR', `[BATCH] No files uploaded`);
        return res.status(400).json({
          error: 'No files uploaded'
        });
      }

      systemLogger.logSystem('INFO', `[BATCH] Received ${req.files.length} files`);
      req.files.forEach((file, index) => {
        systemLogger.logSystem('INFO', `[BATCH] File ${index + 1}: ${file.originalname} (${file.size} bytes)`);
      });

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

      // 3. Process files in background (with error handling)
      this._processFilesInBackground(req.files, batchId, {
        currentPath,
        normalizedFinalDir,
        normalizedStoragePath,
        filePaths: req.body.filePaths || [],
        user: req.user
      }).catch(error => {
        // Log the error but don't crash the server
        systemLogger.logSystem('ERROR', `Background file processing error for batch ${batchId}: ${error.message}`);

        // Mark remaining files as failed
        transferManager.updateBatchProgress(batchId);
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

    // 添加詳細日誌記錄請求開始
    systemLogger.logSystem('INFO', `📥 [UPLOAD START] Single file upload initiated`);
    systemLogger.logSystem('INFO', `Headers: ${JSON.stringify(req.headers)}`);

    try {
      // 1. Manual JWT authentication (since we're not using multer middleware)
      const jwt = require('jsonwebtoken');
      const configManager = require('../config');
      const jwtSecret = configManager.get('security.jwtSecret') || 'file-transfer-secret-key';

      systemLogger.logSystem('INFO', `[UPLOAD] Step 1: Checking authentication`);

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        systemLogger.logSystem('ERROR', `[UPLOAD] Authentication failed: missing or invalid auth header`);
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
        systemLogger.logSystem('INFO', `[UPLOAD] Step 1: Authentication successful for user: ${decoded.username}`);
      } catch (authError) {
        systemLogger.logSystem('ERROR', `[UPLOAD] JWT verification failed: ${authError.message}`);
        return res.status(401).json({
          success: false,
          error: {
            code: 401,
            message: 'Invalid or expired token'
          }
        });
      }

      // 2. Validate Content-Length header
      systemLogger.logSystem('INFO', `[UPLOAD] Step 2: Validating Content-Length`);
      const contentLength = parseInt(req.headers['content-length']);
      systemLogger.logSystem('INFO', `[UPLOAD] Content-Length: ${contentLength} bytes`);

      if (!contentLength || contentLength === 0) {
        systemLogger.logSystem('ERROR', `[UPLOAD] Invalid Content-Length: ${contentLength}`);
        return res.status(400).json({
          success: false,
          error: {
            code: 301,
            message: '檔案Content-Length不完整',
            details: 'Content-Length header is required and must be greater than 0'
          }
        });
      }

      // 3. Get filename and path from query parameters OR form fields
      // Priority: query params > form fields (will be extracted from busboy)
      systemLogger.logSystem('INFO', `[UPLOAD] Step 3: Getting filename and path`);
      let fileName = req.query.fileName;
      let uploadPath = req.query.path || '';
      systemLogger.logSystem('INFO', `[UPLOAD] Initial fileName from query: ${fileName}, path: ${uploadPath}`);

      // fileName and path will be extracted from busboy form fields if not in query
      // We'll validate fileName later when we get it from busboy

      // 4. Initialize Busboy FIRST to extract form fields
      systemLogger.logSystem('INFO', `[UPLOAD] Step 4: Initializing Busboy`);
      const busboy = Busboy({
        headers: req.headers,
        limits: {
          files: 1, // Only accept single file
          fileSize: configManager.get('fileSystem.maxFileSize') || Infinity
        }
      });

      let fileProcessed = false;
      let uploadedBytes = 0;
      let transferId = null;

      // Listen to 'field' event to get fileName and path from FormData
      busboy.on('field', (fieldname, value) => {
        systemLogger.logSystem('INFO', `[UPLOAD] Busboy field received: ${fieldname} = ${value}`);

        // Update fileName and uploadPath from form fields if not in query
        if (fieldname === 'fileName' && !fileName) {
          fileName = value;
          systemLogger.logSystem('INFO', `[UPLOAD] fileName updated from form field: ${fileName}`);
        }
        if (fieldname === 'path') {
          uploadPath = value;
          systemLogger.logSystem('INFO', `[UPLOAD] uploadPath updated from form field: ${uploadPath}`);
        }
      });

      // Helper function to process file upload
      const processFile = async (fieldname, fileStream, info) => {
        const { filename, encoding, mimeType } = info;
        systemLogger.logSystem('INFO', `[UPLOAD] Step 5: Processing file - fieldname: ${fieldname}, filename: ${filename}, mimeType: ${mimeType}`);

        if (fileProcessed) {
          systemLogger.logSystem('WARN', `[UPLOAD] Additional file ignored (already processed one file)`);
          fileStream.resume(); // Discard additional files
          return;
        }
        fileProcessed = true;

        // Now we have fileName from either query or form field
        // If still no fileName, use the filename from file upload
        if (!fileName) {
          fileName = filename || 'unnamed_file';
          systemLogger.logSystem('INFO', `[UPLOAD] fileName fallback to upload filename: ${fileName}`);
        }

        systemLogger.logSystem('INFO', `[UPLOAD] Final fileName: ${fileName}, uploadPath: ${uploadPath}`);

        // Validate and sanitize filename
        let sanitizedFileName;
        try {
          sanitizedFileName = this._sanitizeFilename(fileName);
          systemLogger.logSystem('INFO', `[UPLOAD] Sanitized fileName: ${sanitizedFileName}`);
        } catch (error) {
          // Fail the transfer since we can't proceed
          fileStream.resume(); // Discard file stream
          systemLogger.logSystem('ERROR', `[UPLOAD] Filename sanitization failed: ${error.message}, error code: ${error.code}`);

          if (!res.headersSent) {
            return res.status(400).json({
              success: false,
              error: {
                code: error.code || 304,
                message: error.message || '檔案名稱無效',
                details: `Invalid filename: ${fileName}`
              }
            });
          }
          return;
        }

        // Determine destination path (NOW with correct uploadPath)
        systemLogger.logSystem('INFO', `[UPLOAD] Step 6: Determining destination path`);
        const storagePath = configManager.get('fileSystem.storagePath') || './storage';
        const storageRoot = path.resolve(storagePath);
        systemLogger.logSystem('INFO', `[UPLOAD] Storage root: ${storageRoot}, uploadPath: ${uploadPath}`);
        const targetDir = uploadPath ? path.join(storageRoot, uploadPath) : storageRoot;
        const finalPath = path.join(targetDir, sanitizedFileName);

        systemLogger.logSystem('INFO', `[UPLOAD] Target directory: ${targetDir}`);
        systemLogger.logSystem('INFO', `[UPLOAD] Final path: ${finalPath}`);

        // Security check: ensure path is within storage root
        if (!finalPath.startsWith(storageRoot)) {
          fileStream.resume(); // Discard file stream
          systemLogger.logSystem('ERROR', `[UPLOAD] SECURITY: Path traversal attempt - finalPath: ${finalPath}, storageRoot: ${storageRoot}`);

          if (!res.headersSent) {
            return res.status(403).json({
              success: false,
              error: {
                code: 403,
                message: 'Path traversal attempt blocked'
              }
            });
          }
          return;
        }

        // Create transfer ID and initialize transfer
        systemLogger.logSystem('INFO', `[UPLOAD] Step 7: Creating transfer record`);
        transferId = transferManager.startTransfer({
          fileName: sanitizedFileName,
          totalSize: contentLength,
          destination: finalPath,
          status: 'pending'
        });
        systemLogger.logSystem('INFO', `[UPLOAD] Transfer created with ID: ${transferId}`);

        // Send 202 Accepted response immediately (if not already sent)
        if (!res.headersSent) {
          systemLogger.logSystem('INFO', `[UPLOAD] Step 8: Sending 202 Accepted response`);
          res.status(202).json({
            success: true,
            transferId,
            message: 'Upload initiated. Poll for progress.'
          });
        }

        // Update status to 'uploading'
        transferManager.updateTransferStatus(transferId, 'uploading');
        systemLogger.logSystem('INFO', `[UPLOAD] Step 9: Transfer status updated to 'uploading'`);

        // Create destination directory if it doesn't exist
        systemLogger.logSystem('INFO', `[UPLOAD] Step 10: Creating destination directory: ${targetDir}`);
        try {
          await this.fileSystem.mkdir(targetDir);
          systemLogger.logSystem('INFO', `[UPLOAD] Destination directory ready`);
        } catch (mkdirError) {
          systemLogger.logSystem('ERROR', `[UPLOAD] Failed to create directory: ${mkdirError.message}`);
          fileStream.resume();
          transferManager.failTransfer(transferId, {
            code: 500,
            message: '無法創建目標目錄',
            details: mkdirError.message
          });
          return;
        }

        // Create write stream to destination
        systemLogger.logSystem('INFO', `[UPLOAD] Step 11: Creating write stream to: ${finalPath}`);
        const writeStream = fs.createWriteStream(finalPath);

        // Track upload progress
        let lastLogTime = Date.now();
        fileStream.on('data', (chunk) => {
          uploadedBytes += chunk.length;

          // Update transfer progress in real-time
          transferManager.updateProgress(transferId, uploadedBytes, contentLength);

          // Log progress every second to avoid spamming logs
          const now = Date.now();
          if (now - lastLogTime >= 1000) {
            const progress = ((uploadedBytes / contentLength) * 100).toFixed(2);
            systemLogger.logSystem('INFO', `[UPLOAD] Progress: ${progress}% (${uploadedBytes}/${contentLength} bytes)`);
            lastLogTime = now;
          }
        });

        // Pipe file stream to write stream
        systemLogger.logSystem('INFO', `[UPLOAD] Step 12: Piping file stream to write stream`);
        fileStream.pipe(writeStream);

        // Handle write stream completion
        writeStream.on('finish', () => {
          systemLogger.logSystem('INFO', `[UPLOAD] ✅ Upload completed successfully - transferId: ${transferId}, size: ${uploadedBytes} bytes`);
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
          systemLogger.logSystem('ERROR', `[UPLOAD] ❌ Write stream error - code: ${err.code}, message: ${err.message}`);
          systemLogger.logSystem('ERROR', `[UPLOAD] Error stack: ${err.stack}`);

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
          systemLogger.logSystem('ERROR', `[UPLOAD] ❌ File stream error: ${err.message}`);
          systemLogger.logSystem('ERROR', `[UPLOAD] Error stack: ${err.stack}`);

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
      };

      // 5. Listen to 'file' event (when a file field is encountered)
      // Note: Frontend now sends 'path' field BEFORE 'file', so uploadPath will be available here
      busboy.on('file', async (fieldname, fileStream, info) => {
        const { filename, encoding, mimeType } = info;
        systemLogger.logSystem('INFO', `[UPLOAD] Step 5: File event received - fieldname: ${fieldname}, filename: ${filename}, mimeType: ${mimeType}`);

        if (fileProcessed) {
          systemLogger.logSystem('WARN', `[UPLOAD] Additional file ignored (already processed one file)`);
          fileStream.resume(); // Discard additional files
          return;
        }

        // Process file immediately (path field was received before this)
        await processFile(fieldname, fileStream, info);
      });

      // 10. Handle file size limit exceeded
      busboy.on('limit', () => {
        systemLogger.logSystem('WARN', `[UPLOAD] File size limit exceeded`);
        if (transferId) {
          transferManager.failTransfer(transferId, {
            code: 413,
            message: '檔案大小超過限制',
            details: `Maximum file size: ${configManager.get('fileSystem.maxFileSize')} bytes`
          });
        }
      });

      // 11. Handle busboy errors
      busboy.on('error', (err) => {
        systemLogger.logSystem('ERROR', `[UPLOAD] ❌ Busboy error: ${err.message}`);
        systemLogger.logSystem('ERROR', `[UPLOAD] Busboy error stack: ${err.stack}`);
        if (transferId) {
          transferManager.failTransfer(transferId, {
            code: 500,
            message: '上傳處理錯誤',
            details: err.message
          });
        }
      });

      // 12. Handle request close/abort (client disconnected)
      req.on('close', () => {
        systemLogger.logSystem('WARN', `[UPLOAD] Client disconnected - transferId: ${transferId}`);
        if (transferId) {
          const transfer = transferManager.getTransfer(transferId);
          if (transfer && transfer.status === 'uploading') {
            transferManager.failTransfer(transferId, {
              code: 302,
              message: '檔案上傳中斷',
              details: 'Client disconnected'
            });

            // Clean up partial file (finalPath may not be defined if disconnected early)
            if (typeof finalPath !== 'undefined') {
              fs.unlink(finalPath, () => {});
            }
          }
        }
      });

      // 13. Pipe request to busboy
      systemLogger.logSystem('INFO', `[UPLOAD] Step 13: Piping request to Busboy`);
      req.pipe(busboy);

    } catch (error) {
      systemLogger.logSystem('ERROR', `[UPLOAD] ❌❌❌ CRITICAL ERROR in _handleSingleProgressUpload: ${error.message}`);
      systemLogger.logSystem('ERROR', `[UPLOAD] Error stack: ${error.stack}`);

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

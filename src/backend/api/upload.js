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
      limits: {
        fileSize: 1024 * 1024 * 100 // 100MB limit
      },
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
   * Handle multiple file uploads
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
      
      // Create directory if it doesn't exist
      await this.fileSystem.mkdir(normalizedFinalDir);
      
      const results = [];

      // Check if we have relative paths for folder uploads
      const filePaths = req.body.filePaths || [];
      const hasFolderStructure = Array.isArray(filePaths) && filePaths.length > 0;

      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];

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
          systemLogger.logError(`Security: Attempted path traversal with path: ${finalPath}`, req);
          continue; // Skip this file
        }

        // Create transfer record
        const transferId = transferManager.startTransfer({
          source: file.path,
          destination: normalizedFinalPath,
          totalSize: file.size
        });

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

        results.push({
          name: path.basename(file.originalname),
          path: normalizedFinalPath,
          size: file.size
        });
      }

      // Send success response
      res.json({
        success: true,
        message: `${results.length} file(s) uploaded successfully`,
        files: results
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
   * Get router instance
   */
  getRouter() {
    return this.router;
  }
}

module.exports = UploadAPI;

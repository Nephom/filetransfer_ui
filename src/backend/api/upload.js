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
    this.router.post('/upload', this.upload.array('files', 10), (req, res) => {
      // Simplified: _handleMultipleUpload can handle one or many files
      this._handleMultipleUpload(req, res);
    });

    // Alternative endpoint for single file upload with 'file' field
    this.router.post('/upload/single', this.upload.single('file'), (req, res) => {
      this._handleSingleUpload(req, res);
    });

    // Alternative endpoint for multiple file upload with 'files' field
    this.router.post('/upload/multiple', this.upload.array('files', 10), (req, res) => {
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
      if (!req.file) {
        return res.status(400).json({
          error: 'No file uploaded'
        });
      }

      // Get currentPath from request body to determine destination directory
      const currentPath = req.body.path || '';
      const configManager = require('../config');
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
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          error: 'No files uploaded'
        });
      }

      // Get currentPath from request body to determine destination directory
      const currentPath = req.body.path || '';
      const configManager = require('../config');
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

      for (const file of req.files) {
        // Final file path
        const finalPath = path.join(normalizedFinalDir, path.basename(file.originalname));
        
        // Create transfer record
        const transferId = transferManager.startTransfer({
          source: file.path,
          destination: finalPath,
          totalSize: file.size
        });

        // Move file to final destination in storage
        await this.fileSystem.move(file.path, finalPath);

        // Update transfer as complete
        transferManager.completeTransfer(transferId, {
          result: 'success',
          file: {
            name: path.basename(file.originalname),
            path: finalPath,
            size: file.size
          }
        });

        results.push({
          name: path.basename(file.originalname),
          path: finalPath,
          size: file.size
        });
      }

      systemLogger.logError(`Upload failed: ${error.message}`, req);
      res.status(500).json({
        error: 'Upload failed',
        message: error.message
      });
  }

  /**
   * Handle upload with progress tracking
   * @private
   */
  async _handleUploadWithProgress(req, res) {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: 'No file uploaded'
        });
      }

      // Get currentPath from request body to determine destination directory
      const currentPath = req.body.path || '';
      const configManager = require('../config');
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
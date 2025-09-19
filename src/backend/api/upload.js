/**
 * File Upload API Endpoints
 * Handles file upload operations with progress tracking
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const { transferManager } = require('../transfer');
const { FileSystem } = require('../file-system');

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
    // Configure multer for file uploads
    const storage = multer.diskStorage({
      destination: (req, file, cb) => {
        // Use a temporary directory for uploads
        cb(null, './temp/uploads');
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
    // Single file upload endpoint
    this.router.post('/upload', this.upload.single('file'), (req, res) => {
      this._handleSingleUpload(req, res);
    });

    // Multiple file upload endpoint
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

      // Create transfer record
      const transferId = transferManager.startTransfer({
        source: req.file.path,
        destination: req.body.destination || `./uploads/${req.file.filename}`,
        totalSize: req.file.size
      });

      // Move file to final destination
      const finalPath = path.join('./uploads', req.file.filename);
      await this.fileSystem.move(req.file.path, finalPath);

      // Update transfer as complete
      transferManager.completeTransfer(transferId, {
        result: 'success',
        file: {
          name: req.file.filename,
          path: finalPath,
          size: req.file.size
        }
      });

      res.json({
        success: true,
        transferId,
        message: 'File uploaded successfully',
        file: {
          name: req.file.filename,
          path: finalPath,
          size: req.file.size
        }
      });
    } catch (error) {
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

      const results = [];

      for (const file of req.files) {
        // Create transfer record
        const transferId = transferManager.startTransfer({
          source: file.path,
          destination: `./uploads/${file.filename}`,
          totalSize: file.size
        });

        // Move file to final destination
        const finalPath = path.join('./uploads', file.filename);
        await this.fileSystem.move(file.path, finalPath);

        // Update transfer as complete
        transferManager.completeTransfer(transferId, {
          result: 'success',
          file: {
            name: file.filename,
            path: finalPath,
            size: file.size
          }
        });

        results.push({
          name: file.filename,
          path: finalPath,
          size: file.size
        });
      }

      res.json({
        success: true,
        message: `${req.files.length} files uploaded successfully`,
        files: results
      });
    } catch (error) {
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
      if (!req.file) {
        return res.status(400).json({
          error: 'No file uploaded'
        });
      }

      // Create transfer record
      const transferId = transferManager.startTransfer({
        source: req.file.path,
        destination: req.body.destination || `./uploads/${req.file.filename}`,
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

        // Move file to final destination
        const finalPath = path.join('./uploads', req.file.filename);
        await this.fileSystem.move(req.file.path, finalPath);

        // Update transfer as complete
        transferManager.completeTransfer(transferId, {
          result: 'success',
          file: {
            name: req.file.filename,
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
            name: req.file.filename,
            path: finalPath,
            size: req.file.size
          }
        });
      }, 2000);
    } catch (error) {
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
/**
 * File System Abstraction Layer
 * Provides a unified interface for file operations across different storage backends
 */

// Import base classes from the new base.js file
const { FileSystem, LocalFileSystem } = require('./base');

// Import the enhanced file system that depends on the base classes
const EnhancedMemoryFileSystem = require('./enhanced-memory');

// Export all the components for the module
module.exports = {
  FileSystem,
  LocalFileSystem,
  EnhancedMemoryFileSystem,
};

# Backend Codebase Overview

This document provides an overview of the Node.js backend codebase for the file transfer application. It outlines the purpose of each file and directory to facilitate future development and maintenance.

## Main Server

- **`server.js`**: This is the main entry point for the application. It initializes the Express server, loads the configuration, sets up all middleware (including security, authentication, and static file serving), defines the core API routes, and starts listening for incoming requests.

## Directories

### `api/`
Contains dedicated modules for specific API functionalities.
- **`upload.js`**: Manages all aspects of file uploads. It uses `multer` to handle `multipart/form-data`, defines routes for single and multiple file uploads, and integrates with the `TransferManager` to track progress.

### `auth/`
Handles user authentication and management.
- **`index.js`**: Exports the primary `AuthManager`, which is responsible for JWT-based authentication logic and user session management.
- **`user-manager.js`**: Manages user data, including loading user profiles from the database, verifying credentials against stored hashes, and performing user-related operations.
- **`auth.js`**: Contains legacy authentication logic. Parts of it have been refactored into `AuthManager` and `UserManager`.

### `config/`
Manages application configuration.
- **`index.js`**: Exports a **singleton instance** of the `ConfigManager`. This ensures that the entire application uses a single, consistent source of configuration data, loaded from `.ini` files and environment variables.
- **`config.js`**: Defines the default, fallback configuration values for the application.

### `file-system/`
Provides an abstraction layer for interacting with the file system, allowing for different storage backends (e.g., local, cached).
- **`index.js`**: The main entry point for the file system module. It exports the various file system implementations (`FileSystem`, `LocalFileSystem`, `EnhancedMemoryFileSystem`).
- **`base.js`**: Defines the fundamental `FileSystem` (abstract base class) and `LocalFileSystem` (standard local disk interaction) classes. This file was created to resolve a circular dependency.
- **`memory-cache.js`**: Implements the `RedisFileSystemCache`. This class uses Redis to cache file system metadata and `chokidar` to watch for real-time changes, providing a high-performance, cached view of the file system.
- **`enhanced-memory.js`**: Implements a file system class that combines a local file system with the Redis caching layer from `memory-cache.js`.
- **`operations.js`**: Handles high-level, stateful file operations requested by the API, such as copy, move, and delete, often orchestrating multiple `FileSystem` calls.
- **`enhanced.js`**: (Deprecated) An older implementation using SQLite for caching.
- **`cache.js`**: (Deprecated) An older, simpler caching mechanism.

### `middleware/`
Contains custom Express middleware functions.
- **`auth.js`**: Provides the `authenticate` middleware, which inspects JWT tokens from incoming requests to verify user sessions and protect routes.
- **`security.js`**: Implements security-focused middleware, including rate limiting for authentication attempts (`authLimiter`) and file uploads (`fileLimiter`) to prevent abuse.

### `security/`
Contains security-related helper utilities.
- **`security.js`**: Provides utility functions for common security tasks. Its primary function, `hashWithSalt`, is now an **asynchronous** function used for securely hashing passwords with `pbkdf2`.

### `transfer/`
Manages and tracks the progress of file transfers.
- **`index.js`**: Exports a singleton instance of the `transferManager`.
- **`progress.js`**: Contains the `TransferManager` class, which is responsible for creating unique transfer IDs and tracking the progress of uploads and downloads in memory.

## Issue Tracking
- **`issue_memory-cache.js`**: A special file created to document a known issue regarding the `RedisFileSystemCache` where the file watcher was disabled. It details the problem, its impact, and the suggested solution.

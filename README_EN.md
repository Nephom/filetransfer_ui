[正體中文](README.md)

# Web-Based File Management System

A full-featured local file management system with a modern web interface and powerful command-line tools.

> **🤖 AI-Generated Code Demonstration**  
> This project was developed through multiple AI-assisted iterations, showcasing collaborative development between human requirements and AI implementation. The codebase demonstrates modern web development practices, performance optimizations, and real-world problem-solving through iterative refinement.

## Features

*   **Web Interface**: Browse, upload, download, delete, and rename files through a web browser.
*   **User Authentication**: Secure JWT (JSON Web Token) login and password management.
*   **High-Performance Cache**: Uses Redis to create a global file index cache, speeding up file listing and search responses.
*   **Powerful Command-Line Tools**: Provides the `fileapi.sh` script for all file operations and system management via the command-line.
*   **Configurable Security**: Offers various optional security mechanisms like rate limiting, security headers, and input validation.

## Prerequisites

1.  **Node.js**: v20 or higher.
2.  **Redis Server**: A Redis Server must be running locally. You can quickly start a Redis instance using Docker:
    ```bash
    docker run -d --name my-redis -p 6379:6379 redis
    ```
3.  **NPM Packages**: Project dependencies need to be installed first.

## Quick Start

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Configure the Application (Required Step)**:
    Before use, you **must** modify the `src/config.ini` file and set at least the following items:
    *   `storagePath`: The root directory for file storage.
    *   `username` / `password`: The default administrator account credentials.
    ```bash
    # It is recommended to open and modify with your preferred editor
    vi src/config.ini
    ```

3.  **Start the Server**:
    ```bash
    ./start.sh
    ```
    After the server starts, it will begin building the file system cache in the background. The first startup may take some time, depending on the number of files in `storagePath`.

4.  **Access the Application**:
    *   Open your browser and go to `http://localhost:3000` (or the port you configured in `config.ini`).
    *   Log in with the administrator account you configured.

## Command-Line Tool (`fileapi.sh`)

This project provides a feature-rich `bash` script, `fileapi.sh`, allowing you to manage files directly from the terminal.

**Show all commands**:
```bash
./fileapi.sh help
```

**Common Examples**:
```bash
# Log in (stores the token in .api_token)
./fileapi.sh login <your_username> <your_password>

# List files in the root directory
./fileapi.sh list

# List files in a specific directory
./fileapi.sh list documents/

# Upload a file
./fileapi.sh upload /path/to/local/file.txt (storagePATH/)documents/ # the documents folder under parameter storagePATH in config.ini

# Search for files
./fileapi.sh search "*.pdf"

# Refresh the cache
./fileapi.sh cache-refresh
```

## Important Notes

*   **Redis Cache and Search**: The system relies on Redis for file indexing. After the first start or after running `cache-refresh`, the system will scan and cache the file structure in the background. During this time, the search function may not return complete results. You can use the `cache-stats` or `index-status` commands to monitor the progress.
*   **Server Management**:
    *   **Check Status**: `./status.sh`
    *   **Stop Server**: `./stop.sh`

## License

MIT License - See the `LICENSE` file for details.

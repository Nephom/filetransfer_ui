# File Transfer UI System

A comprehensive file transfer system with modern UI and robust backend functionality.

> **🤖 AI-Generated Code Demonstration**  
> This project was developed through multiple AI-assisted iterations, showcasing collaborative development between human requirements and AI implementation. The codebase demonstrates modern web development practices, performance optimizations, and real-world problem-solving through iterative refinement.

## Precondition
1. Need Redis-server on your site(Docker is OK)
2. Node.js version 22 above

## Features Implemented

## Quick Start

1. **Change Config.ini**:
   ```bash
   vi src/config.ini
   ```
   To change port if you want, and default admin account or password.
   And default storagePath!!!!

   **Sorry about the bash script using Tranditional Chinese**

   **Start the server**:
   ```bash
   ./start.sh
   ```

   **Check Server Status**:
   ```bash
   ./status.sh
   ```
   
   **Stop Server**:
   ```bash
   ./stop.sh
   ```

   **Using bash script to quick access**:
   ```bash
   ./fileapi.sh help
   ```

2. **Access the application**:
   - Open http://localhost:3000(if you using default config)
   - Login with: admin / password(if you using default config)

3. **Configuration**:
   - Edit `src/config.ini` for custom settings
   - Default storage path: `./storage`

## Architecture

## Configuration

The system uses `src/config.ini` for configuration:
- Server port (default: 3000)
- Storage path (default: ./storage)
- Authentication credentials
- Security features (all disabled by default)

## Security

**Always Enabled**:
- JWT token authentication
- Password hashing (bcrypt)
- HTTPS support (when configured)

**Configurable** (disabled by default):
- Rate limiting
- Security headers
- Input validation
- File upload security
- Request logging

## License

MIT License - see LICENSE file for details.

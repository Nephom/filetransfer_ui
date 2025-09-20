# File Transfer UI System

A comprehensive file transfer system with modern UI and robust backend functionality.

## Features Implemented

### 🚀 **Complete File Management System**
- **Folder Navigation**: Click to enter folders, back button navigation
- **File Operations**: Upload, delete, create folders, file selection
- **Modern UI**: Silver-gray-blue gradient tech aesthetic with glass effects
- **Drag & Drop**: Full drag-and-drop file upload support
- **Search**: Real-time file search functionality
- **View Modes**: Grid and list view options
- **File Types**: Proper file type detection with custom icons

### 🔐 **Authentication & Security**
- JWT-based authentication system
- Configurable security features (rate limiting, headers, validation)
- Secure password handling with bcrypt hashing
- Default credentials: admin / password

### 🎨 **Modern UI Components**
- Futuristic glass-morphism design
- Responsive file browser with proper folder/file distinction
- Progress tracking and loading states
- Error handling with user-friendly messages
- Mobile-responsive design

### 📁 **File System Features**
- Cross-platform file operations (Windows, macOS, Linux)
- Proper file type detection using `fs.stat()`
- File size display and metadata
- Folder creation and navigation
- Batch file operations

## Quick Start

1. **Start the server**:
   ```bash
   node src/backend/server.js
   ```

2. **Access the application**:
   - Open http://localhost:3000
   - Login with: admin / password

3. **Configuration**:
   - Edit `src/config.ini` for custom settings
   - Default storage path: `./storage`

## Architecture

### Backend Structure
```
src/backend/
├── server.js              # Main server file
├── file-system/           # File operations
├── auth/                  # Authentication
├── middleware/            # Security middleware
└── config/               # Configuration management
```

### Frontend Structure
```
src/frontend/public/
├── index.html            # Main HTML file
├── app.js               # React application
└── components/          # UI components
```

## Current Features Status

✅ **Working Features**:
- User authentication (admin/password)
- File listing with proper folder/file detection
- Folder navigation and back button
- File upload via drag-and-drop or file picker
- Folder creation
- File/folder deletion
- Search functionality
- Grid/list view toggle
- Modern silver-gray-blue UI theme

🔄 **In Development**:
- File download functionality
- File rename operations
- Copy/paste operations
- Progress tracking for large uploads

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

## Contributing

This project demonstrates a complete file transfer system with modern web technologies. All code follows best practices for security, performance, and maintainability.

## License

MIT License - see LICENSE file for details.

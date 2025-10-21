# File Transfer Documentation

Welcome to the File Transfer system documentation.

---

## Documentation Structure

### API Documentation

The complete API documentation is available in the `api/` directory:

- **[API Overview](./api/README.md)** - Complete API documentation index
  - Quick start guide
  - API workflow diagrams
  - Data models and status values
  - Best practices and examples

- **[Upload API](./api/upload.md)** - Upload endpoint documentation
  - Single file upload with real-time progress
  - Multi-file batch upload
  - Folder upload with structure preservation
  - Request/response formats

- **[Progress Tracking API](./api/progress.md)** - Progress monitoring
  - Single transfer progress tracking
  - Batch progress tracking
  - Polling strategies
  - Performance metrics

- **[Error Codes](./api/error-codes.md)** - Error code reference
  - Custom error codes (301, 302, 304, 401, 402, 403, 413)
  - Error handling examples
  - User-friendly error messages

---

## Quick Links

### For Developers

- [Getting Started](#getting-started)
- [API Overview](./api/README.md)
- [Upload Examples](./api/upload.md#request-example)
- [Error Handling](./api/error-codes.md)

### For API Users

- [Authentication](./api/README.md#authentication)
- [Single File Upload](./api/upload.md#single-file-upload-with-real-time-progress)
- [Multi-File Upload](./api/upload.md#multi-file-upload-with-batch-tracking)
- [Progress Polling](./api/progress.md)

---

## Getting Started

### 1. Authentication

All API endpoints require JWT authentication:

```javascript
// Login to get token
const response = await fetch('/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'your_username',
    password: 'your_password'
  })
});

const { token } = await response.json();
```

### 2. Upload a File

```javascript
// Prepare file upload
const formData = new FormData();
formData.append('file', fileObject);
formData.append('fileName', 'document.pdf');

// Initiate upload
const uploadResponse = await fetch('/api/upload/single-progress', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` },
  body: formData
});

const { transferId } = await uploadResponse.json();
```

### 3. Track Progress

```javascript
// Poll for progress
const pollInterval = setInterval(async () => {
  const response = await fetch(`/api/progress/${transferId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const progress = await response.json();
  console.log(`Progress: ${progress.progress}%`);

  if (progress.status === 'completed') {
    clearInterval(pollInterval);
    console.log('Upload completed!');
  }
}, 1000);
```

---

## Features

### Real-Time Progress Tracking

- **Streaming Upload**: Files are processed as streams using Busboy
- **Real Progress**: Track actual file write progress, not just network transfer
- **Batch Support**: Upload multiple files with aggregate progress tracking
- **Individual File Status**: Monitor each file's progress in batch uploads

### Error Handling

- **Custom Error Codes**: Specific codes for different error scenarios
- **Automatic Cleanup**: Failed uploads automatically clean up partial files
- **Detailed Messages**: Clear error messages in Chinese and English

### Security

- **JWT Authentication**: All endpoints require valid JWT tokens
- **Path Traversal Prevention**: Automatic sanitization of file paths
- **Filename Validation**: UTF-8 encoding and illegal character filtering
- **Rate Limiting**: Protection against abuse

### Performance

- **Memory Efficient**: Streaming architecture prevents memory overflow
- **Async Processing**: Multi-file uploads process in background
- **Progress Caching**: In-memory progress tracking for fast polling

---

## API Architecture

### Upload Flow

```
Client                Server                 Storage
  │                     │                       │
  ├─ POST /upload ─────>│                       │
  │  (file data)        │                       │
  │                     ├─ Create transferId    │
  │                     ├─ Start streaming ────>│
  │<─ 202 Accepted ─────┤   (write file)        │
  │  { transferId }     │                       │
  │                     │                       │
  ├─ GET /progress ────>│                       │
  │<─ Progress data ────┤                       │
  │  { progress: 50% }  │                       │
  │                     │                       │
  │      (polling)      │                       │
  │         ...         │                       │
  │                     │                       │
  ├─ GET /progress ────>│                       │
  │<─ Complete ─────────┤                       │
  │  { status: done }   │<─ File saved ─────────┤
```

### Batch Upload Flow

```
Client                Server                 Storage
  │                     │                       │
  ├─ POST /multiple ───>│                       │
  │  (multiple files)   │                       │
  │                     ├─ Create batchId       │
  │<─ 202 Accepted ─────┤                       │
  │  { batchId }        │                       │
  │                     ├─ Process files ──────>│
  │                     │   (background)        │
  │                     │                       │
  ├─ GET /batch ───────>│                       │
  │<─ Batch stats ──────┤                       │
  │  { 3/10 files }     │                       │
  │                     │                       │
  │      (polling)      │                       │
  │         ...         │                       │
  │                     │                       │
  ├─ GET /batch ───────>│                       │
  │<─ Complete ─────────┤                       │
  │  { 10/10 done }     │<─ All saved ──────────┤
```

---

## Technology Stack

### Backend

- **Node.js**: Runtime environment
- **Express.js**: Web framework
- **Busboy**: Multipart form-data parser for streaming
- **UUID**: Unique ID generation for transfers and batches

### Storage

- **File System**: Local file storage with configurable path
- **In-Memory**: Progress tracking using Map data structures

### Security

- **JWT**: JSON Web Tokens for authentication
- **Helmet**: Security headers middleware
- **Rate Limiting**: Request rate limiting per IP

---

## Configuration

Server configuration is managed in `src/backend/config/`:

```javascript
{
  fileSystem: {
    storagePath: './storage',      // File storage directory
    maxFileSize: 10000 * 1024 * 1024 // 10 GB max file size
  },
  security: {
    jwtSecret: 'your-secret-key',  // JWT signing secret
    tokenExpiry: '24h'             // Token expiration time
  }
}
```

---

## Troubleshooting

### Common Issues

**Upload fails with error 301**
- Check that Content-Length header is set
- Verify file object is valid

**Upload fails with error 304**
- Filename contains illegal characters
- Sanitize filename before upload

**Upload fails with error 401**
- Server disk is full
- Contact system administrator

**Progress polling returns 404**
- Transfer ID is invalid or expired
- Verify transfer ID from upload response

### Debug Mode

Enable debug logging in development:

```javascript
process.env.DEBUG = 'true';
```

---

## Contributing

To contribute to this project:

1. Read the API documentation
2. Understand the architecture
3. Follow coding standards
4. Write tests for new features
5. Update documentation

---

## Version History

### Version 2.0.0 (Current)

**Release Date**: January 2025

**New Features**:
- Real-time progress tracking
- Batch upload support
- Custom error codes
- UTF-8 filename support
- Automatic cleanup

**API Changes**:
- Added `POST /api/upload/single-progress`
- Modified `POST /api/upload/multiple` (now async)
- Added `GET /api/progress/:transferId`
- Added `GET /api/progress/batch/:batchId`

### Version 1.0.0

**Release Date**: 2024

**Features**:
- Basic file upload
- JWT authentication
- File validation

---

## License

Copyright © 2025. All rights reserved.

---

**Last Updated**: January 2025

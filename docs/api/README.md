# File Transfer API Documentation

Complete API documentation for the File Transfer system with real-time progress tracking.

---

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [API Endpoints](#api-endpoints)
- [Authentication](#authentication)
- [Documentation Index](#documentation-index)
- [Change Log](#change-log)

---

## Overview

This API provides file upload capabilities with real-time progress tracking. It supports:

- **Single File Upload** with streaming progress
- **Multi-File Batch Upload** with aggregate progress
- **Real-Time Progress Tracking** via polling endpoints
- **Folder Upload** with preserved directory structure
- **Comprehensive Error Handling** with custom error codes

### Key Features

✅ **Real-time Progress**: Track actual file write progress on server
✅ **Batch Management**: Upload multiple files with aggregate statistics
✅ **Streaming Architecture**: Memory-efficient handling using Busboy
✅ **UTF-8 Support**: Full support for international filenames
✅ **Error Recovery**: Automatic cleanup and detailed error reporting
✅ **Security**: Path traversal prevention and filename sanitization

---

## Quick Start

### 1. Single File Upload

```javascript
// Step 1: Initiate upload
const formData = new FormData();
formData.append('file', fileObject);
formData.append('fileName', 'document.pdf');
formData.append('path', 'uploads');

const uploadResponse = await fetch('/api/upload/single-progress', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_JWT_TOKEN'
  },
  body: formData
});

const { transferId } = await uploadResponse.json();

// Step 2: Poll for progress
const pollInterval = setInterval(async () => {
  const progressResponse = await fetch(`/api/progress/${transferId}`, {
    headers: { 'Authorization': 'Bearer YOUR_JWT_TOKEN' }
  });

  const progress = await progressResponse.json();
  console.log(`Progress: ${progress.progress}%`);

  if (progress.status === 'completed') {
    clearInterval(pollInterval);
    console.log('Upload completed!');
  } else if (progress.status === 'failed') {
    clearInterval(pollInterval);
    console.error('Upload failed:', progress.error);
  }
}, 1000);
```

### 2. Multi-File Upload

```javascript
// Step 1: Initiate batch upload
const formData = new FormData();
files.forEach(file => {
  formData.append('files', file);
});
formData.append('path', 'uploads/images');

const uploadResponse = await fetch('/api/upload/multiple', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_JWT_TOKEN'
  },
  body: formData
});

const { batchId } = await uploadResponse.json();

// Step 2: Poll for batch progress
const pollInterval = setInterval(async () => {
  const progressResponse = await fetch(`/api/progress/batch/${batchId}`, {
    headers: { 'Authorization': 'Bearer YOUR_JWT_TOKEN' }
  });

  const batch = await progressResponse.json();
  console.log(`Batch: ${batch.successCount}/${batch.totalFiles} completed`);
  console.log(`Progress: ${batch.progress}%`);

  if (['completed', 'partial_fail', 'failed'].includes(batch.status)) {
    clearInterval(pollInterval);
    console.log('Batch upload finished:', batch.status);
  }
}, 1000);
```

---

## API Endpoints

### Upload Endpoints

| Endpoint | Method | Description | Response |
|----------|--------|-------------|----------|
| `/api/upload/single-progress` | POST | Upload single file with progress | `{ transferId }` |
| `/api/upload/multiple` | POST | Upload multiple files in batch | `{ batchId }` |
| `/api/upload` | POST | Legacy upload (no progress tracking) | File metadata |

### Progress Tracking Endpoints

| Endpoint | Method | Description | Response |
|----------|--------|-------------|----------|
| `/api/progress/:transferId` | GET | Get single transfer progress | Transfer status |
| `/api/progress/batch/:batchId` | GET | Get batch progress | Batch status |

---

## Authentication

All endpoints require JWT authentication via the `Authorization` header:

```
Authorization: Bearer <your_jwt_token>
```

### Obtaining a Token

```javascript
// Login to get JWT token
const response = await fetch('/auth/login', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    username: 'your_username',
    password: 'your_password'
  })
});

const { token } = await response.json();

// Use token for subsequent requests
localStorage.setItem('token', token);
```

### Token Expiration

- Tokens expire after a configured period (default: 24 hours)
- API returns `401 Unauthorized` when token is invalid or expired
- Implement token refresh or redirect to login page

---

## Documentation Index

### Core Documentation

- **[Upload API](./upload.md)** - Complete upload endpoint documentation
  - Single file upload with real-time progress
  - Multi-file batch upload
  - Folder upload with structure preservation
  - Request/response formats and examples

- **[Progress Tracking API](./progress.md)** - Progress monitoring documentation
  - Single transfer progress tracking
  - Batch progress tracking
  - Polling strategies and best practices
  - Performance metrics calculation

- **[Error Codes](./error-codes.md)** - Comprehensive error code reference
  - All custom error codes (301, 302, 304, 401, 402, 403, 413)
  - Error handling examples
  - User-friendly error messages
  - Recovery strategies

---

## API Workflow

### Single File Upload Workflow

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │
       │ POST /api/upload/single-progress
       │ (FormData with file)
       ▼
┌──────────────┐
│   Server     │──────► Create transferId
└──────┬───────┘       Start streaming upload
       │
       │ 202 Accepted
       │ { transferId: "uuid" }
       ▼
┌─────────────┐
│   Client    │
└──────┬──────┘
       │
       │ GET /api/progress/:transferId
       │ (Poll every 1 second)
       ▼
┌──────────────┐
│   Server     │──────► Return current progress
└──────┬───────┘       { progress: 45.5%, status: "uploading" }
       │
       │ 200 OK
       │ { progress, status, ... }
       ▼
┌─────────────┐
│   Client    │──────► Update UI
└──────┬──────┘       Continue polling
       │
       │ (When status === "completed")
       ▼
┌─────────────┐
│   Client    │──────► Stop polling
└─────────────┘       Show success message
```

### Multi-File Batch Upload Workflow

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │
       │ POST /api/upload/multiple
       │ (FormData with multiple files)
       ▼
┌──────────────┐
│   Server     │──────► Create batchId
└──────┬───────┘       Create transfers for each file
       │               Process files in background
       │ 202 Accepted
       │ { batchId: "uuid" }
       ▼
┌─────────────┐
│   Client    │
└──────┬──────┘
       │
       │ GET /api/progress/batch/:batchId
       │ (Poll every 1 second)
       ▼
┌──────────────┐
│   Server     │──────► Calculate batch statistics
└──────┬───────┘       { successCount: 7, totalFiles: 10, progress: 70% }
       │
       │ 200 OK
       │ { batch stats, files array, ... }
       ▼
┌─────────────┐
│   Client    │──────► Update UI with batch progress
└──────┬──────┘       Show individual file statuses
       │
       │ (When all files processed)
       ▼
┌─────────────┐
│   Client    │──────► Stop polling
└─────────────┘       Show completion status
                      (completed/partial_fail/failed)
```

---

## Data Models

### Transfer Object

```typescript
interface Transfer {
  id: string;              // UUID
  status: TransferStatus;  // pending | uploading | processing | completed | failed
  fileName: string;        // UTF-8 encoded filename
  totalSize: number;       // Total file size in bytes
  transferredSize: number; // Bytes transferred so far
  progress: number;        // Progress percentage (0.00 - 100.00)
  error: Error | null;     // Error object if status is 'failed'
}
```

### Batch Object

```typescript
interface Batch {
  batchId: string;         // UUID
  status: BatchStatus;     // uploading | completed | partial_fail | failed
  totalFiles: number;      // Total number of files in batch
  successCount: number;    // Number of successfully uploaded files
  failedCount: number;     // Number of failed files
  pendingCount: number;    // Number of pending/uploading/processing files
  totalSize: number;       // Total size of all files in bytes
  transferredSize: number; // Total bytes transferred across all files
  progress: number;        // Overall batch progress (0.00 - 100.00)
  files: FileProgress[];   // Array of individual file progress
}
```

### File Progress Object

```typescript
interface FileProgress {
  fileName: string;     // Name of the file
  status: TransferStatus;
  progress: number;     // File progress percentage
  error: string | null; // Error message if file failed
}
```

---

## Status Values

### Transfer Status

| Status | Description |
|--------|-------------|
| `pending` | Transfer created but upload not started |
| `uploading` | File is being uploaded to server |
| `processing` | Upload complete, server processing file |
| `completed` | Transfer successfully completed |
| `failed` | Transfer failed (see error field) |

### Batch Status

| Status | Description |
|--------|-------------|
| `uploading` | Batch is currently being processed |
| `completed` | All files uploaded successfully (failedCount === 0) |
| `partial_fail` | Some files succeeded, some failed |
| `failed` | All files failed (successCount === 0) |

---

## Rate Limits

To prevent abuse, the API implements rate limiting:

| Endpoint | Limit | Window |
|----------|-------|--------|
| Upload endpoints | 100 requests | per IP per 15 minutes |
| Progress endpoints | 1000 requests | per IP per 15 minutes |

Exceeded limits return `429 Too Many Requests`.

---

## Best Practices

### 1. Progress Polling

- Poll at **1-2 second intervals** (not faster)
- **Stop polling** when status is `completed` or `failed`
- Implement **timeout** for very large files (e.g., 10 minutes)
- **Clean up intervals** when component unmounts

### 2. Error Handling

- Always handle network errors
- Implement retry logic for transient errors (302)
- Show user-friendly error messages
- Log errors for debugging

### 3. File Validation

- Validate file size on client before upload
- Sanitize filenames to remove illegal characters
- Check file types if restrictions apply
- Use UTF-8 encoding for all filenames

### 4. Performance

- For large files, use single file endpoint
- For many small files, use batch endpoint
- Don't poll faster than 1 second
- Implement exponential backoff on errors

### 5. Security

- Always use HTTPS in production
- Never expose JWT tokens
- Validate all user inputs
- Set appropriate file size limits

---

## Examples

### Complete Upload Component (React)

```javascript
import React, { useState } from 'react';

function FileUploader({ token }) {
  const [file, setFile] = useState(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);

  const uploadFile = async () => {
    if (!file) return;

    try {
      setStatus('uploading');
      setError(null);

      // Initiate upload
      const formData = new FormData();
      formData.append('file', file);
      formData.append('fileName', file.name);

      const uploadRes = await fetch('/api/upload/single-progress', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });

      if (!uploadRes.ok) {
        const errorData = await uploadRes.json();
        throw new Error(errorData.error.message);
      }

      const { transferId } = await uploadRes.json();

      // Poll for progress
      const pollInterval = setInterval(async () => {
        try {
          const progressRes = await fetch(`/api/progress/${transferId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });

          const progressData = await progressRes.json();
          setProgress(progressData.progress);

          if (progressData.status === 'completed') {
            clearInterval(pollInterval);
            setStatus('completed');
          } else if (progressData.status === 'failed') {
            clearInterval(pollInterval);
            setStatus('failed');
            setError(progressData.error?.message || 'Upload failed');
          }
        } catch (err) {
          clearInterval(pollInterval);
          setStatus('failed');
          setError('Failed to fetch progress');
        }
      }, 1000);

    } catch (err) {
      setStatus('failed');
      setError(err.message);
    }
  };

  return (
    <div>
      <input
        type="file"
        onChange={(e) => setFile(e.target.files[0])}
      />

      <button onClick={uploadFile} disabled={!file || status === 'uploading'}>
        Upload
      </button>

      {status === 'uploading' && (
        <div>
          <progress value={progress} max="100" />
          <span>{progress.toFixed(1)}%</span>
        </div>
      )}

      {status === 'completed' && <p>Upload completed!</p>}
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </div>
  );
}

export default FileUploader;
```

---

## Change Log

### Version 2.0.0 (Current)

**New Features:**
- Real-time progress tracking using Busboy streaming
- Batch upload support with aggregate progress
- Individual file status tracking in batches
- Custom error codes (301, 302, 304, 401, 402, 403)
- UTF-8 filename support with sanitization
- Automatic cleanup of partial uploads

**API Changes:**
- Added `POST /api/upload/single-progress` endpoint
- Modified `POST /api/upload/multiple` to return `batchId`
- Added `GET /api/progress/:transferId` endpoint
- Added `GET /api/progress/batch/:batchId` endpoint

**Breaking Changes:**
- Multi-file upload now returns `202 Accepted` immediately
- Progress must be polled separately (no synchronous response)

### Version 1.0.0 (Legacy)

**Features:**
- Synchronous file upload
- Basic file validation
- Authentication required

---

## Support

For issues, questions, or feature requests:

- **GitHub Issues**: [github.com/your-repo/issues](https://github.com/your-repo/issues)
- **Email**: support@example.com
- **Documentation**: [https://docs.example.com](https://docs.example.com)

---

## License

This API documentation is part of the File Transfer project.

Copyright © 2025. All rights reserved.

---

**Last Updated**: January 2025
**API Version**: 2.0.0

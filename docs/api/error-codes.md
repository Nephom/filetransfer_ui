# Error Codes Documentation

This document describes all custom error codes used in the File Transfer API.

---

## Error Response Format

All API errors follow this standard format:

```json
{
  "success": false,
  "error": {
    "code": 301,
    "message": "檔案Content-Length不完整",
    "details": "Additional error information"
  }
}
```

### Error Object Fields

| Field | Type | Description |
|-------|------|-------------|
| `code` | number | Custom error code (see below) |
| `message` | string | Human-readable error message (Chinese) |
| `details` | string | Additional technical details (optional) |

---

## Upload Error Codes

### Error 301: Content-Length Missing

**HTTP Status**: 400 Bad Request

**Message**: `檔案Content-Length不完整`

**Description**: The request is missing the Content-Length header or the Content-Length is zero.

**Cause**:
- Missing `Content-Length` header
- Content-Length set to 0
- Invalid Content-Length value

**Example Response**:
```json
{
  "success": false,
  "error": {
    "code": 301,
    "message": "檔案Content-Length不完整",
    "details": "Content-Length header is required and must be greater than 0"
  }
}
```

**How to Fix**:
```javascript
// Ensure Content-Length is set in multipart/form-data
const formData = new FormData();
formData.append('file', fileObject); // File object automatically includes size

// For raw binary uploads, set Content-Length explicitly
fetch('/api/upload/single-progress', {
  method: 'POST',
  headers: {
    'Content-Length': file.size.toString()
  },
  body: fileData
});
```

---

### Error 302: Upload Interrupted

**HTTP Status**: 499 Client Closed Request

**Message**: `檔案上傳中斷`

**Description**: The file upload was interrupted before completion.

**Cause**:
- Client disconnected during upload
- Network connection lost
- Client cancelled the upload
- Browser/tab closed during upload
- Stream error during file transfer

**Example Response**:
```json
{
  "success": false,
  "error": {
    "code": 302,
    "message": "檔案上傳中斷",
    "details": "Client disconnected"
  }
}
```

**Progress API Response** (when checking status of interrupted upload):
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "failed",
  "fileName": "document.pdf",
  "totalSize": 10485760,
  "transferredSize": 2097152,
  "progress": 20.00,
  "error": {
    "code": 302,
    "message": "檔案上傳中斷",
    "details": "Upload interrupted"
  }
}
```

**How to Handle**:
```javascript
// Implement retry logic
async function uploadWithRetry(file, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await uploadFile(file);
      return result;
    } catch (error) {
      if (error.code === 302 && attempt < maxRetries - 1) {
        console.log(`Upload interrupted, retrying (${attempt + 1}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
        continue;
      }
      throw error;
    }
  }
}

// Handle connection close events
xhr.addEventListener('abort', () => {
  console.log('Upload was cancelled');
});
```

**Note**: Temporary files are automatically cleaned up when upload is interrupted.

---

### Error 304: Illegal Filename Characters

**HTTP Status**: 400 Bad Request

**Message**: `檔案名稱包含非法字元`

**Description**: The filename contains characters that are not allowed by the file system.

**Cause**:
- Filename contains illegal characters: `< > : " | ? * \0-\x1F`
- Path traversal attempt: `..`, `/`, `\`
- Invalid UTF-8 encoding

**Example Response**:
```json
{
  "success": false,
  "error": {
    "code": 304,
    "message": "檔案名稱包含非法字元",
    "details": "Invalid filename: file<name>.txt"
  }
}
```

**Illegal Characters**:

| Character(s) | Reason |
|--------------|--------|
| `< > : " \| ? *` | Windows reserved characters |
| `\0-\x1F` | Control characters |
| `/` `\` | Path separators |
| `..` | Parent directory reference (security) |

**How to Fix**:
```javascript
// Sanitize filename before upload
function sanitizeFilename(filename) {
  // Remove illegal characters
  let clean = filename.replace(/[<>:"|?*\x00-\x1F]/g, '_');

  // Remove path separators
  clean = clean.replace(/[\/\\]/g, '_');

  // Remove parent directory references
  clean = clean.replace(/\.\./g, '_');

  // Ensure valid UTF-8
  clean = Buffer.from(clean, 'utf8').toString('utf8');

  return clean;
}

// Example usage
const originalName = 'my<file>.txt';
const safeName = sanitizeFilename(originalName); // 'my_file_.txt'

formData.append('fileName', safeName);
```

**Best Practices**:
- Validate filenames on client-side before upload
- Use only alphanumeric characters, hyphens, underscores, and dots
- Always use UTF-8 encoding for filenames
- URL-encode filenames in query parameters

---

### Error 401: Disk Space Full

**HTTP Status**: 507 Insufficient Storage

**Message**: `服務端磁碟空間已滿，請洽管理員`

**Description**: The server has run out of disk space and cannot store the uploaded file.

**Cause**:
- Server disk is full (ENOSPC error)
- Storage quota exceeded
- Insufficient space for file size

**Example Response**:
```json
{
  "success": false,
  "error": {
    "code": 401,
    "message": "服務端磁碟空間已滿，請洽管理員",
    "details": "No space left on device"
  }
}
```

**Progress API Response**:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "failed",
  "fileName": "large-file.zip",
  "totalSize": 1073741824,
  "transferredSize": 536870912,
  "progress": 50.00,
  "error": {
    "code": 401,
    "message": "服務端磁碟空間已滿，請洽管理員"
  }
}
```

**How to Handle**:
```javascript
// Check for disk space error
if (error.code === 401) {
  alert('Server storage is full. Please contact the administrator.');

  // Optionally notify admin
  notifyAdmin({
    type: 'storage_full',
    timestamp: new Date().toISOString(),
    attemptedFileSize: file.size
  });
}
```

**Resolution**:
- Contact system administrator
- Free up disk space on server
- Increase storage capacity
- Implement storage quotas and monitoring

**Note**: Partial files are automatically cleaned up when this error occurs.

---

### Error 402: Transfer Not Found

**HTTP Status**: 404 Not Found

**Message**: `Transfer ID 不存在`

**Description**: The requested transfer ID does not exist in the system.

**Cause**:
- Invalid transfer ID
- Transfer ID expired (cleaned up)
- Typo in transfer ID
- Transfer was never created

**Example Response**:
```json
{
  "success": false,
  "error": {
    "code": 402,
    "message": "Transfer ID 不存在"
  }
}
```

**Endpoint**: `GET /api/progress/:transferId`

**How to Handle**:
```javascript
async function getProgress(transferId) {
  try {
    const response = await fetch(`/api/progress/${transferId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (response.status === 404) {
      const error = await response.json();
      if (error.error.code === 402) {
        console.error('Transfer not found. It may have been cleaned up.');
        // Stop polling
        return null;
      }
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to fetch progress:', error);
    return null;
  }
}
```

**Prevention**:
- Store transfer ID immediately after upload initiation
- Validate transfer ID format before polling
- Implement proper error handling in polling loop

---

### Error 403: Batch Not Found

**HTTP Status**: 404 Not Found

**Message**: `Batch ID 不存在`

**Description**: The requested batch ID does not exist in the system.

**Cause**:
- Invalid batch ID
- Batch ID expired (cleaned up)
- Typo in batch ID
- Batch was never created

**Example Response**:
```json
{
  "success": false,
  "error": {
    "code": 403,
    "message": "Batch ID 不存在"
  }
}
```

**Endpoint**: `GET /api/progress/batch/:batchId`

**How to Handle**:
```javascript
async function getBatchProgress(batchId) {
  try {
    const response = await fetch(`/api/progress/batch/${batchId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (response.status === 404) {
      const error = await response.json();
      if (error.error.code === 403) {
        console.error('Batch not found. It may have been cleaned up.');
        // Stop polling
        return null;
      }
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to fetch batch progress:', error);
    return null;
  }
}
```

---

### Error 413: File Too Large

**HTTP Status**: 413 Payload Too Large

**Message**: `檔案大小超過限制`

**Description**: The uploaded file exceeds the maximum allowed file size.

**Cause**:
- File size exceeds server configuration limit
- File size exceeds Busboy limits

**Example Response**:
```json
{
  "success": false,
  "error": {
    "code": 413,
    "message": "檔案大小超過限制",
    "details": "Maximum file size: 104857600 bytes"
  }
}
```

**How to Handle**:
```javascript
// Check file size before upload
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

function validateFileSize(file) {
  if (file.size > MAX_FILE_SIZE) {
    alert(`File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024} MB`);
    return false;
  }
  return true;
}

// Before upload
if (!validateFileSize(file)) {
  return;
}
```

**Configuration**: Check server settings for `fileSystem.maxFileSize`

---

## General HTTP Errors

### 401 Unauthorized

**Message**: Authentication required or invalid token

**Cause**:
- Missing Authorization header
- Invalid JWT token
- Expired JWT token

**How to Fix**:
```javascript
// Ensure token is valid and included
fetch('/api/upload/single-progress', {
  headers: {
    'Authorization': `Bearer ${validToken}`
  },
  // ...
});

// Handle token expiration
if (response.status === 401) {
  // Refresh token or redirect to login
  refreshToken().then(newToken => {
    // Retry request with new token
  });
}
```

---

### 500 Internal Server Error

**Message**: Internal server error

**Cause**:
- Unexpected server error
- Unhandled exception
- Database error
- File system error

**Example Response**:
```json
{
  "success": false,
  "error": {
    "code": 500,
    "message": "Internal server error",
    "details": "Error details (in development mode)"
  }
}
```

**How to Handle**:
```javascript
if (response.status === 500) {
  console.error('Server error occurred');

  // Show user-friendly message
  alert('An unexpected error occurred. Please try again later.');

  // Optionally report to error tracking service
  reportError({
    type: 'server_error',
    endpoint: '/api/upload/single-progress',
    timestamp: new Date().toISOString()
  });
}
```

---

## Error Handling Best Practices

### Comprehensive Error Handling

```javascript
async function handleUpload(file) {
  try {
    const response = await fetch('/api/upload/single-progress', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: createFormData(file)
    });

    if (!response.ok) {
      const errorData = await response.json();

      switch (errorData.error?.code) {
        case 301:
          showError('Missing file information');
          break;
        case 302:
          showError('Upload interrupted. Please try again.');
          break;
        case 304:
          showError('Invalid filename. Please rename the file.');
          break;
        case 401:
          showError('Server storage is full. Contact administrator.');
          break;
        case 402:
          showError('Transfer not found.');
          break;
        case 403:
          showError('Batch not found.');
          break;
        case 413:
          showError('File is too large.');
          break;
        default:
          showError(errorData.error?.message || 'Upload failed');
      }

      return null;
    }

    return await response.json();

  } catch (error) {
    console.error('Network error:', error);
    showError('Network error. Please check your connection.');
    return null;
  }
}
```

### User-Friendly Error Messages

Map technical errors to user-friendly messages:

```javascript
const ERROR_MESSAGES = {
  301: {
    title: 'Upload Error',
    message: 'The file information is incomplete. Please try again.',
    action: 'Retry'
  },
  302: {
    title: 'Upload Interrupted',
    message: 'Your upload was interrupted. Would you like to try again?',
    action: 'Retry'
  },
  304: {
    title: 'Invalid Filename',
    message: 'The filename contains invalid characters. Please rename the file.',
    action: 'Rename'
  },
  401: {
    title: 'Storage Full',
    message: 'The server storage is full. Please contact the administrator.',
    action: 'Contact Admin'
  },
  413: {
    title: 'File Too Large',
    message: 'This file exceeds the maximum allowed size.',
    action: 'Choose Smaller File'
  }
};

function displayError(code) {
  const error = ERROR_MESSAGES[code] || {
    title: 'Error',
    message: 'An error occurred. Please try again.',
    action: 'OK'
  };

  showModal(error.title, error.message, error.action);
}
```

### Logging and Monitoring

```javascript
function logError(error, context) {
  const errorLog = {
    timestamp: new Date().toISOString(),
    code: error.code,
    message: error.message,
    details: error.details,
    context: context,
    userAgent: navigator.userAgent
  };

  // Send to logging service
  sendToLoggingService(errorLog);

  // Log to console in development
  if (process.env.NODE_ENV === 'development') {
    console.error('Upload error:', errorLog);
  }
}
```

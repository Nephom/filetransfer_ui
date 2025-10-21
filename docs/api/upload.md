# Upload API Documentation

This document describes the file upload endpoints with real-time progress tracking.

---

## Single File Upload with Real-Time Progress

Upload a single file with real-time progress tracking.

### Endpoint

```
POST /api/upload/single-progress
```

### Authentication

Requires JWT token in Authorization header.

### Request Headers

| Header | Type | Required | Description |
|--------|------|----------|-------------|
| `Authorization` | string | Yes | Bearer token format: `Bearer <jwt_token>` |
| `Content-Type` | string | Yes | Must be `multipart/form-data` |

### Request Body (FormData)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | File | Yes | The file to upload |
| `fileName` | string | Yes | Name of the file (UTF-8 encoded) |
| `path` | string | No | Destination directory path (relative to storage root, defaults to root) |

### Request Example

```javascript
const formData = new FormData();
formData.append('file', fileObject);
formData.append('fileName', 'document.pdf');
formData.append('path', 'uploads/documents');

const response = await fetch('/api/upload/single-progress', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_JWT_TOKEN'
  },
  body: formData
});

const data = await response.json();
console.log('Transfer ID:', data.transferId);
```

### Response

#### Success Response (202 Accepted)

```json
{
  "success": true,
  "transferId": "550e8400-e29b-41d4-a716-446655440000",
  "message": "Upload initiated. Poll for progress."
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Always `true` for successful initiation |
| `transferId` | string | UUID for tracking upload progress |
| `message` | string | Status message |

#### Error Response (4xx/5xx)

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

### Error Codes

| Code | HTTP Status | Message | Description |
|------|-------------|---------|-------------|
| 301 | 400 | 檔案Content-Length不完整 | Content-Length header missing or zero |
| 302 | 499 | 檔案上傳中斷 | Upload interrupted by client or network |
| 304 | 400 | 檔案名稱包含非法字元 | Filename contains illegal characters |
| 401 | 507 | 服務端磁碟空間已滿，請洽管理員 | Server disk space full (ENOSPC) |
| 413 | 413 | 檔案大小超過限制 | File size exceeds maximum allowed |
| 500 | 500 | Internal server error | Unexpected server error |

### Usage Flow

1. **Initiate Upload**: Send POST request with file
2. **Receive Transfer ID**: Server responds with `transferId` immediately (202 Accepted)
3. **Poll Progress**: Use `GET /api/progress/:transferId` to track progress
4. **Complete**: Progress reaches 100% and status becomes `completed`

### Notes

- Upload is processed asynchronously using Busboy streaming
- Progress tracking reflects actual file write progress on server
- Temporary files are automatically cleaned up on errors
- All filenames are sanitized and validated for UTF-8 encoding
- Path traversal attacks are prevented

---

## Multi-File Upload with Batch Tracking

Upload multiple files or folders with batch progress tracking.

### Endpoint

```
POST /api/upload/multiple
```

### Authentication

Requires JWT token in Authorization header.

### Request Headers

| Header | Type | Required | Description |
|--------|------|----------|-------------|
| `Authorization` | string | Yes | Bearer token format: `Bearer <jwt_token>` |
| `Content-Type` | string | Yes | Must be `multipart/form-data` |

### Request Body (FormData)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `files` | File[] | Yes | Array of files to upload |
| `filePaths[]` | string[] | No | Relative paths for folder structure (for folder uploads) |
| `path` | string | No | Destination directory path (defaults to root) |

### Request Example

#### Multiple Files

```javascript
const formData = new FormData();
files.forEach(file => {
  formData.append('files', file);
});
formData.append('path', 'uploads/images');

const response = await fetch('/api/upload/multiple', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_JWT_TOKEN'
  },
  body: formData
});

const data = await response.json();
console.log('Batch ID:', data.batchId);
```

#### Folder Upload

```javascript
const formData = new FormData();
files.forEach(file => {
  formData.append('files', file);
  if (file.webkitRelativePath) {
    formData.append('filePaths[]', file.webkitRelativePath);
  }
});
formData.append('path', 'uploads/my-project');

const response = await fetch('/api/upload/multiple', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_JWT_TOKEN'
  },
  body: formData
});

const data = await response.json();
console.log('Batch ID:', data.batchId);
```

### Response

#### Success Response (202 Accepted)

```json
{
  "success": true,
  "batchId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "message": "Batch upload initiated. Poll for batch progress."
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Always `true` for successful initiation |
| `batchId` | string | UUID for tracking batch progress |
| `message` | string | Status message |

#### Error Response (4xx/5xx)

```json
{
  "success": false,
  "error": {
    "code": 500,
    "message": "Batch upload initiation failed",
    "details": "Error message details"
  }
}
```

### Usage Flow

1. **Initiate Batch Upload**: Send POST request with multiple files
2. **Receive Batch ID**: Server responds with `batchId` immediately (202 Accepted)
3. **Poll Batch Progress**: Use `GET /api/progress/batch/:batchId` to track progress
4. **Complete**: All files processed, batch status becomes `completed`, `partial_fail`, or `failed`

### Batch Processing

- Files are processed in the background after immediate response
- Each file creates an individual transfer within the batch
- Batch progress is calculated from all file transfers
- Individual file failures don't stop the batch
- Folder structure is preserved when `filePaths[]` is provided

### Notes

- Maximum file size and count limits apply (configurable in server settings)
- Files are processed sequentially to manage server resources
- Failed files are tracked with error messages
- Batch status reflects overall completion state
- All files are subject to same validation as single file upload

---

## Legacy Upload Endpoint

For backward compatibility, the original upload endpoint is still available.

### Endpoint

```
POST /api/upload
```

This endpoint uses the old synchronous upload mechanism without real-time progress tracking. **Recommended to use the new endpoints above for better user experience.**

### Differences from New Endpoints

- Waits for all files to upload before responding (200 OK)
- No real-time progress tracking
- No transfer ID or batch ID returned
- Less efficient for large files or multiple files

---

## Best Practices

### File Naming

- Use UTF-8 encoded filenames
- Avoid special characters: `< > : " | ? * \0-\x1F`
- Avoid path traversal characters: `..`, `/`, `\`
- URL-encode filenames in query parameters

### Error Handling

```javascript
try {
  const response = await fetch('/api/upload/single-progress', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData
  });

  if (!response.ok) {
    const errorData = await response.json();

    switch (errorData.error.code) {
      case 301:
        console.error('Missing Content-Length header');
        break;
      case 401:
        console.error('Server disk space full');
        break;
      case 302:
        console.error('Upload interrupted');
        break;
      case 304:
        console.error('Invalid filename characters');
        break;
      default:
        console.error('Upload failed:', errorData.error.message);
    }

    return;
  }

  const { transferId } = await response.json();
  // Start polling for progress...

} catch (error) {
  console.error('Network error:', error);
}
```

### Progress Polling

```javascript
async function pollProgress(transferId) {
  const pollInterval = setInterval(async () => {
    try {
      const response = await fetch(`/api/progress/${transferId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) {
        clearInterval(pollInterval);
        console.error('Failed to fetch progress');
        return;
      }

      const progress = await response.json();
      updateProgressBar(progress.progress);

      if (progress.status === 'completed') {
        clearInterval(pollInterval);
        console.log('Upload completed!');
      } else if (progress.status === 'failed') {
        clearInterval(pollInterval);
        console.error('Upload failed:', progress.error);
      }

    } catch (error) {
      clearInterval(pollInterval);
      console.error('Polling error:', error);
    }
  }, 1000); // Poll every second
}
```

### Security Considerations

- Always use HTTPS in production
- Validate JWT token on every request
- Sanitize all filenames on server side
- Implement rate limiting for upload endpoints
- Set appropriate file size limits
- Validate file types if needed
- Prevent path traversal attacks

### Performance Tips

- For large files, use single file endpoint for better progress tracking
- For many small files, use batch upload to reduce overhead
- Poll progress at reasonable intervals (1-2 seconds)
- Stop polling when upload completes or fails
- Clean up resources and intervals on component unmount

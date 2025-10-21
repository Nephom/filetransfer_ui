# Progress Tracking API Documentation

This document describes the progress tracking endpoints for monitoring file upload status.

---

## Get Single Transfer Progress

Query the progress of a single file upload.

### Endpoint

```
GET /api/progress/:transferId
```

### Authentication

Requires JWT token in Authorization header.

### Request Headers

| Header | Type | Required | Description |
|--------|------|----------|-------------|
| `Authorization` | string | Yes | Bearer token format: `Bearer <jwt_token>` |

### URL Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `transferId` | string (UUID) | Yes | Transfer ID returned from upload initiation |

### Request Example

```javascript
const transferId = '550e8400-e29b-41d4-a716-446655440000';

const response = await fetch(`/api/progress/${transferId}`, {
  headers: {
    'Authorization': 'Bearer YOUR_JWT_TOKEN'
  }
});

const progress = await response.json();
console.log('Upload progress:', progress.progress + '%');
```

### Response

#### Success Response (200 OK)

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "uploading",
  "fileName": "document.pdf",
  "totalSize": 10485760,
  "transferredSize": 4194304,
  "progress": 40.00,
  "error": null
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (UUID) | Transfer ID |
| `status` | string | Current transfer status (see below) |
| `fileName` | string | Name of the file being uploaded |
| `totalSize` | number | Total file size in bytes |
| `transferredSize` | number | Bytes transferred so far |
| `progress` | number | Progress percentage (0.00 - 100.00) |
| `error` | object/null | Error information if status is `failed` |

#### Transfer Status Values

| Status | Description |
|--------|-------------|
| `pending` | Transfer created but upload not started |
| `uploading` | File is being uploaded to server |
| `processing` | Upload complete, server processing file |
| `completed` | Transfer successfully completed |
| `failed` | Transfer failed (see `error` field) |

#### Error Response (404 Not Found)

```json
{
  "success": false,
  "error": {
    "code": 402,
    "message": "Transfer ID 不存在"
  }
}
```

### Progress Calculation

Progress is calculated as:
```javascript
progress = (transferredSize / totalSize) * 100
```

Rounded to 2 decimal places.

### Polling Recommendations

- **Poll Interval**: 1-2 seconds
- **Stop Polling When**: Status is `completed` or `failed`
- **Timeout**: Consider implementing a timeout after 5-10 minutes for very large files
- **Error Handling**: Stop polling if API returns 404 (transfer not found)

### Example: Polling Implementation

```javascript
async function pollTransferProgress(transferId, onProgress, onComplete, onError) {
  const pollInterval = setInterval(async () => {
    try {
      const response = await fetch(`/api/progress/${transferId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) {
        clearInterval(pollInterval);
        onError('Failed to fetch progress');
        return;
      }

      const progress = await response.json();

      // Update UI with progress
      onProgress(progress);

      // Check completion
      if (progress.status === 'completed') {
        clearInterval(pollInterval);
        onComplete(progress);
      } else if (progress.status === 'failed') {
        clearInterval(pollInterval);
        onError(progress.error || 'Upload failed');
      }

    } catch (error) {
      clearInterval(pollInterval);
      onError(error.message);
    }
  }, 1000);

  return pollInterval; // Return for manual cleanup if needed
}

// Usage
const pollInterval = pollTransferProgress(
  transferId,
  (progress) => {
    console.log(`Progress: ${progress.progress}%`);
    updateProgressBar(progress.progress);
  },
  (result) => {
    console.log('Upload completed:', result);
    showSuccessMessage();
  },
  (error) => {
    console.error('Upload error:', error);
    showErrorMessage(error);
  }
);
```

---

## Get Batch Progress

Query the progress of a multi-file batch upload.

### Endpoint

```
GET /api/progress/batch/:batchId
```

### Authentication

Requires JWT token in Authorization header.

### Request Headers

| Header | Type | Required | Description |
|--------|------|----------|-------------|
| `Authorization` | string | Yes | Bearer token format: `Bearer <jwt_token>` |

### URL Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `batchId` | string (UUID) | Yes | Batch ID returned from multi-file upload initiation |

### Request Example

```javascript
const batchId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const response = await fetch(`/api/progress/batch/${batchId}`, {
  headers: {
    'Authorization': 'Bearer YOUR_JWT_TOKEN'
  }
});

const batchProgress = await response.json();
console.log(`Batch: ${batchProgress.successCount}/${batchProgress.totalFiles} completed`);
```

### Response

#### Success Response (200 OK)

```json
{
  "batchId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "status": "uploading",
  "totalFiles": 10,
  "successCount": 7,
  "failedCount": 1,
  "pendingCount": 2,
  "totalSize": 52428800,
  "transferredSize": 41943040,
  "progress": 80.00,
  "files": [
    {
      "fileName": "image1.jpg",
      "status": "completed",
      "progress": 100.00,
      "error": null
    },
    {
      "fileName": "image2.png",
      "status": "completed",
      "progress": 100.00,
      "error": null
    },
    {
      "fileName": "archive.zip",
      "status": "failed",
      "progress": 0,
      "error": "服務端磁碟空間已滿，請洽管理員"
    },
    {
      "fileName": "video.mp4",
      "status": "uploading",
      "progress": 45.50,
      "error": null
    }
  ]
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `batchId` | string (UUID) | Batch ID |
| `status` | string | Current batch status (see below) |
| `totalFiles` | number | Total number of files in batch |
| `successCount` | number | Number of successfully uploaded files |
| `failedCount` | number | Number of failed files |
| `pendingCount` | number | Number of files pending/uploading/processing |
| `totalSize` | number | Total size of all files in bytes |
| `transferredSize` | number | Total bytes transferred across all files |
| `progress` | number | Overall batch progress percentage (0.00 - 100.00) |
| `files` | array | Array of individual file progress objects |

#### Batch Status Values

| Status | Description |
|--------|-------------|
| `uploading` | Batch is currently being processed |
| `completed` | All files uploaded successfully |
| `partial_fail` | Some files succeeded, some failed |
| `failed` | All files failed |

#### File Object Fields

| Field | Type | Description |
|-------|------|-------------|
| `fileName` | string | Name of the file |
| `status` | string | File transfer status (same as single transfer) |
| `progress` | number | File progress percentage (0.00 - 100.00) |
| `error` | string/null | Error message if file failed |

#### Error Response (404 Not Found)

```json
{
  "success": false,
  "error": {
    "code": 403,
    "message": "Batch ID 不存在"
  }
}
```

### Batch Completion Logic

A batch is considered complete when:
```
successCount + failedCount === totalFiles
```

Final status is determined by:
- **completed**: `failedCount === 0`
- **partial_fail**: `failedCount > 0 && successCount > 0`
- **failed**: `successCount === 0`

### Example: Batch Progress Polling

```javascript
async function pollBatchProgress(batchId, onProgress, onComplete, onError) {
  const pollInterval = setInterval(async () => {
    try {
      const response = await fetch(`/api/progress/batch/${batchId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) {
        clearInterval(pollInterval);
        onError('Failed to fetch batch progress');
        return;
      }

      const batchData = await response.json();

      // Update UI with progress
      onProgress(batchData);

      // Check if batch is complete
      const isComplete = (
        batchData.status === 'completed' ||
        batchData.status === 'partial_fail' ||
        batchData.status === 'failed'
      );

      if (isComplete) {
        clearInterval(pollInterval);
        onComplete(batchData);
      }

    } catch (error) {
      clearInterval(pollInterval);
      onError(error.message);
    }
  }, 1000);

  return pollInterval;
}

// Usage
const pollInterval = pollBatchProgress(
  batchId,
  (batch) => {
    console.log(`Batch progress: ${batch.progress}%`);
    console.log(`Files: ${batch.successCount}/${batch.totalFiles} completed`);

    updateProgressBar(batch.progress);
    updateFileList(batch.files);
  },
  (result) => {
    if (result.status === 'completed') {
      console.log('All files uploaded successfully!');
    } else if (result.status === 'partial_fail') {
      console.warn(`${result.failedCount} files failed`);
    } else {
      console.error('All files failed');
    }

    showCompletionMessage(result);
  },
  (error) => {
    console.error('Batch polling error:', error);
    showErrorMessage(error);
  }
);
```

---

## Progress Statistics

Both single transfer and batch progress provide detailed statistics for monitoring.

### Real-Time Updates

- Progress is updated in real-time as files are written to disk
- Network transfer speed depends on client connection
- Server processing includes file validation and storage
- Progress reflects actual bytes written, not just received

### Performance Metrics

From progress data, you can calculate:

#### Upload Speed

```javascript
const uploadSpeed = transferredSize / (Date.now() - startTime);
console.log(`Speed: ${(uploadSpeed / 1024 / 1024).toFixed(2)} MB/s`);
```

#### Estimated Time Remaining

```javascript
const remainingBytes = totalSize - transferredSize;
const timeRemaining = remainingBytes / uploadSpeed;
console.log(`ETA: ${Math.ceil(timeRemaining / 1000)} seconds`);
```

#### Batch Statistics

```javascript
// Success rate
const successRate = (successCount / totalFiles) * 100;
console.log(`Success rate: ${successRate.toFixed(1)}%`);

// Average file size
const avgFileSize = totalSize / totalFiles;
console.log(`Average file size: ${(avgFileSize / 1024).toFixed(2)} KB`);
```

---

## Best Practices

### Efficient Polling

```javascript
class ProgressPoller {
  constructor(endpoint, token, interval = 1000) {
    this.endpoint = endpoint;
    this.token = token;
    this.interval = interval;
    this.pollInterval = null;
  }

  start(onProgress, onComplete, onError) {
    this.pollInterval = setInterval(async () => {
      try {
        const response = await fetch(this.endpoint, {
          headers: { 'Authorization': `Bearer ${this.token}` }
        });

        if (!response.ok) {
          this.stop();
          onError('Failed to fetch progress');
          return;
        }

        const data = await response.json();
        onProgress(data);

        if (this.isComplete(data)) {
          this.stop();
          onComplete(data);
        }

      } catch (error) {
        this.stop();
        onError(error.message);
      }
    }, this.interval);
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  isComplete(data) {
    // Override in subclass
    return data.status === 'completed' || data.status === 'failed';
  }
}

// Usage
const poller = new ProgressPoller(`/api/progress/${transferId}`, token);
poller.start(
  (progress) => updateUI(progress),
  (result) => console.log('Done:', result),
  (error) => console.error('Error:', error)
);

// Cleanup on component unmount
onUnmount(() => poller.stop());
```

### Error Handling

Always handle these scenarios:
- Network errors during polling
- 404 errors (transfer/batch not found)
- Authentication errors (expired token)
- Timeout for extremely long uploads
- Component unmount during polling

### Memory Management

- Stop polling when component unmounts
- Clear intervals to prevent memory leaks
- Don't keep large progress histories in memory
- Clean up completed transfers after display

### UI/UX Recommendations

- Show progress bar for visual feedback
- Display current status text (uploading/processing/completed)
- Show file count for batch uploads
- Display individual file status in batch
- Provide cancel option (if implemented)
- Show error messages clearly
- Auto-refresh file list on completion

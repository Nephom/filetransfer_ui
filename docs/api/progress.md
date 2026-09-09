# Upload Progress And Cancellation

Progress records are in-memory upload diagnostics, not durable or resumable jobs.
Use the batch ID from [batch reservation](./upload.md) before sending multipart
bytes. Keep that ID even when upload acceptance or a progress response is lost.

## Routes And Authorization

| Method | Route | Result |
| --- | --- | --- |
| `GET` | `/api/progress/batch/:batchId` | Safe batch summary and child records |
| `GET` | `/api/progress/:transferId` | Safe single-transfer record |
| `POST` | `/api/progress/batch/:batchId/cancel` | Actual batch state after cancellation settlement |
| `POST` | `/api/progress/:transferId/cancel` | Actual transfer state after cancellation settlement |

Every request authenticates the current account using a session cookie or Bearer
token. Both account ID and username must match the stored owner. The stored
Location must still permit upload/write and have the same revision. An optional
`X-Location-ID` must agree with the record; it cannot select a different Location
for an existing job. Missing/not-owned records return `404`; revoked permissions
return `403`; changed Location revisions return `409`. Owner identity, canonical
roots, staging/destination paths, revision hashes, credentials, and worker controls
are never included in public progress.

Account IDs are compared without coercion, including numeric administrator `0` and
numeric regular-account IDs. A string ID with the same digits cannot access a
numeric owner's records. If supplied, `X-Location-Revision` must match the current
stored Location revision; a stale revision returns `409` rather than polling or
cancelling work in a different runtime context.

Successful responses use `Cache-Control: no-store` and `200`. A cancellation still
unconfirmed as `cancelling` uses `202`; that is not confirmation that cleanup has
finished. POST cancellation is idempotent and uses the same safe response shape as
GET. GET does not cancel work.

## Byte Semantics

| Field | Meaning |
| --- | --- |
| `totalSize` | Numeric file-content total; `0` while unknown |
| `totalSizeKnown` | Distinguishes unknown totals from a measured zero-byte total |
| `transferredSize` | Actual file-content bytes observed while receiving/staging; never multipart framing |
| `committedSize` | Measured bytes in successfully published files |
| `progress` | Numeric percentage, rounded to two decimals and bounded to 0-100 |
| `phase` | Current lifecycle stage, independent of byte percentage |

Transport progress is separate: browser/native request-byte counters may include
multipart framing and do not prove server receipt or commitment. `Content-Length`
is not used for `totalSize`. Receiving totals are unknown until file streams have
ended. A batch total remains unknown until its complete validated inventory has
been registered and every child's size is measured.

`transferredSize` counts payload bytes, including bytes later discarded on failure
or cancellation. It is not a disk-flush or publication acknowledgement. During
processing, received/staged bytes are not counted a second time as files are copied
to their destinations. Completion never pads a counter to a declared total.

For a known nonzero total, `progress = transferredSize / totalSize * 100`, rounded
and capped at 100. Unknown totals have numeric progress `0`. Known zero-byte work
has progress `0` while pending and `100` only when completed. File bytes may reach
100 before publication: **status, not percentage, determines success**.

## Transfer Response

```json
{
  "id": "transfer-uuid",
  "batchId": "batch-uuid",
  "locationId": "default",
  "fileName": "document.pdf",
  "status": "processing",
  "phase": "processing",
  "totalSize": 1024,
  "totalSizeKnown": true,
  "transferredSize": 1024,
  "committedSize": 0,
  "progress": 100,
  "startTime": 1788955200000,
  "updatedAt": 1788955201000,
  "error": null
}
```

`endTime` is present after settlement. A completed file also includes allowlisted
`file: {name, path, size}`, where `path` is relative to its Location and includes
collision renaming. Failure errors contain only a fixed public code/message, not
raw filesystem errors or stack traces.

| Status | Meaning |
| --- | --- |
| `pending` | Validated staged child waiting for processing |
| `uploading` | File payload is arriving (`phase: receiving`) |
| `processing` | Waiting for storage locks or publishing staged content |
| `cancelling` | Stop requested; worker/cleanup has not settled |
| `completed` | Output committed; later cancellation cannot remove it |
| `failed` | Work or cleanup failed |
| `cancelled` | This uncommitted child's work stopped and cleanup settled |

The terminal phases match their statuses. Late progress, failure, and completion
callbacks cannot overwrite a terminal result.

## Batch Response

```json
{
  "batchId": "batch-uuid",
  "locationId": "default",
  "status": "uploading",
  "phase": "processing",
  "createdAt": 1788955200000,
  "updatedAt": 1788955201000,
  "expiresAt": 1788956100000,
  "totalFiles": 3,
  "successCount": 1,
  "failedCount": 0,
  "cancelledCount": 0,
  "pendingCount": 2,
  "uploadingCount": 0,
  "processingCount": 1,
  "totalSize": 3072,
  "totalSizeKnown": true,
  "transferredSize": 3072,
  "committedSize": 1024,
  "progress": 100,
  "files": [],
  "error": null
}
```

`files` contains safe child transfer objects using the preceding transfer schema;
it is omitted from the example for brevity. Existing count names are unchanged:
`pendingCount` includes every nonterminal child, including uploading, processing,
and cancelling children, not just children whose status is literally `pending`.
`uploadingCount` and `processingCount` are subsets, not additional pending work.

After inventory validation:

```text
totalFiles = successCount + failedCount + cancelledCount + pendingCount
```

All validated children are registered before `202` acceptance. During reserved
multipart reception, only discovered children can be counted; `totalSizeKnown`
remains false. Directory-only batches have zero children, known zero bytes after
validation, and settle only after directory operations and cleanup finish.

| Batch status | Meaning |
| --- | --- |
| `reserved` | Owned reservation, not yet claimed; phase is `reserved` |
| `uploading` | Intake (`receiving`) or accepted storage work (`processing`) |
| `cancelling` | Cancellation requested; workers/cleanup still settling |
| `completed` | All work committed successfully, including zero-byte/directory-only work |
| `partial_fail` | Some files completed and some failed |
| `failed` | Intake/outer worker/cleanup failed, or all files failed |
| `cancelled` | Cancellation settled; inspect counts for committed/failed children |
| `expired` | An unused reservation passed its fixed expiry |

## Cancellation Races

Cancellation aborts receiving/publication streams and shared-lock waits. Queued
children have their staging files removed without waiting for an unrelated active
sibling. An individual accepted child can be cancelled while siblings continue.
Cancelling a child during multipart reception interrupts that multipart request;
it cannot be published as a fully validated batch.

The cancellation response waits for affected work and owned cleanup. A cancelled
batch can retain completed files and directories; it is not a rollback. If all
outputs committed before the stop request took effect, `completed` wins. If cleanup
fails, the server reports `failed`, not confirmed `cancelled`. A failed HTTP request
or a client transport abort is not itself a server cancellation acknowledgement.

## Polling And Retention

Poll approximately every 1-2 seconds while active. Retry failed GET requests with
backoff using the same ID. Never restart file upload merely because a poll failed,
timed out, or returned `404`; after a server restart or retention cleanup, the
outcome may be unknown. Reconcile storage/user intent instead of creating duplicates.
Stop automatic polling on terminal status, or when the owning session/Location
changes; retain the attempt ID for later explicit reconciliation.

Unused reservations expire after 15 minutes without being extended by reads.
Terminal records become eligible for removal after the default 24-hour retention
window; actual removal depends on the server cleanup schedule. Active records are
not failed or removed because they stop emitting progress. Active batch children
and privately registered workers stay retained until settlement. Client queue
history cleanup is independent. A server process restart loses these records and
does not imply resumability or confirmation of an unknown outcome.

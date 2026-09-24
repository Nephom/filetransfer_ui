# Queue Maintenance Guide

## Add An Upload Or Download

1. Create a Queue item before performing any network or filesystem transfer.
2. Put platform-specific work in an executor. Desktop executors use Tauri
   commands; WebUI executors use `fetch`, `XMLHttpRequest`, or browser stream
   APIs. Do not share those implementations.
3. Report normalized byte progress and item counts through the existing Queue
   progress model. Use `null` for unknown totals.
4. Release readers, listeners, timers, abort controllers, object URLs and
   temporary handles in `finally`.
5. Route toolbar, double-click, context-menu and drag/drop entry points to the
   same Queue admission path.
6. Add a test for success, cancellation, a retryable failure, a non-retryable
   failure and a late callback after cancellation.

## Lifecycle Rules

API upload chunk retries are bounded and idempotent: after a lost response, query
the same session and continue from its stored offset. Authentication, permission,
conflict, missing source, changed source, checksum mismatch and unavailable
destination errors require a user decision. A browser download without File System
Access API is a normal browser download, not resumable.

`needs_user_action` is a coordination state until the user explicitly resumes the
same API upload session. Completed files remain complete; only unfinished files and
byte ranges are sent. Sessions expire four hours after creation. Browser clients ask
the user to reselect sources after reload and verify chunk checksums. Desktop clients
reopen captured paths and verify them before continuing. Other restored transfers
must not be reported as completed or silently rebound to new credentials. Sensitive
request headers, bodies, and download URLs must not be persisted.

## Cleanup

Use `removeQueueItem` only for terminal client items. Active items must be
cancelled first. The client retains completed/cancelled history for 24 hours
and failed history for 7 days, bounded by the documented per-state counts.
Legacy batch progress records are independent in-memory diagnostics and are pruned
by `TransferManager.cleanup()`. Resumable upload manifests and offsets are persisted
in SQLite; expired staging is removed by the resumable-session cleanup task.

## Public Shares

`share.html` is an unauthenticated public boundary and cannot update an
authenticated FileBrowser Queue. Keep its local indicator separate unless a
future server-backed public transfer queue is explicitly introduced.

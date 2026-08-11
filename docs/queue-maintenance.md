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

The only automatic retries are bounded network, timeout and transient server
failures. Authentication, permission, conflict, missing source, changed source
and unavailable destination errors require a user decision. A browser download
without File System Access API is a normal browser download, not resumable.

`paused` and `needs_user_action` are coordination states, not promises of
resume support. If a client process disappears, in-memory items must not be
reported as completed; the safe behavior is a new full transfer after explicit
cleanup or a user decision.

## Cleanup

Use `removeQueueItem` only for terminal client items. Active items must be
cancelled first. The client retains completed/cancelled history for 24 hours
and failed history for 7 days, bounded by the documented per-state counts.
Server progress records are independent in-memory diagnostics and are pruned
by `TransferManager.cleanup()` without removing active records.

## Public Shares

`share.html` is an unauthenticated public boundary and cannot update an
authenticated FileBrowser Queue. Keep its local indicator separate unless a
future server-backed public transfer queue is explicitly introduced.

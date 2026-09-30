# Queue Maintenance Guide

The [Transfer Queue contract](./queue.md) defines shared states, progress
semantics, retries, cancellation, and history retention. This guide describes how
to connect a new transfer entry point to that contract.

## Add an Upload or Download Entry Point

1. Create a Queue item before starting network or filesystem transfer work.
2. Put platform-specific work in an executor. Desktop uses Tauri commands;
   WebUI uses browser networking and file APIs. Keep their executors separate.
3. Report byte progress and item counts through the Queue progress model. Use
   `null` when a total is unknown.
4. Release readers, listeners, timers, abort controllers, object URLs, and
   temporary handles in a `finally` path.
5. Route toolbar, double-click, context-menu, and drag/drop actions through the
   same Queue admission path.

## Resume and Cleanup

Resumable API uploads continue through the same server session and its
authoritative byte offsets. Do not create a replacement attempt because a chunk
response or progress request was lost. Browser clients reselect local sources
after reload; Desktop reopens captured paths and validates the source manifest.
See the [Upload API](./api/upload.md) and [Progress API](./api/progress.md) for
session, offset, cancellation, and retention contracts.

Remove only terminal client Queue items. Cancel active work first and wait for
its executor resources to settle. Client Queue history and server-side progress
records have independent retention policies; see [History Cleanup](./queue.md#history-cleanup).

## Public Shares

`share.html` is an unauthenticated public boundary and cannot update an
authenticated FileBrowser Queue. Keep its local download status separate from
the authenticated Queue.

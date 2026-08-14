# Transfer Queue

The Desktop `fileapi_ui` and the browser WebUI use separate Queue implementations
with the same lifecycle rules. They do not share executors: Desktop transfers
run through Tauri commands, while WebUI transfers run through browser `fetch`
and the File System Access API when available.

## Coverage

Every application-owned upload and download enters a Queue before execution.
Move, rename, delete, folder creation and share-link creation are not transfers
and remain immediate file operations.

Desktop file dragging is intentionally limited to the in-app HTML5 drag/drop
surface. This supports LOCAL <-> API Remote and LOCAL <-> SSH/SFTP Remote
transfers through the existing transfer paths. Windows must keep
`dragDropEnabled: false`: enabling Tauri's native drop target intercepts the
same WebView2 gesture before the in-app `dragover`/`drop` handlers receive it.
Explorer drops and REMOTE-to-Explorer native drag-out are intentionally not
supported. Use the file picker or Download/Queue instead. This is a deliberate
developer decision and should not change unless a separate native and in-app
drag channel becomes technically available.

Desktop lifecycle primitives live under `fileapi_ui/src/queue/`: `state.ts`
contains transitions, `recovery.ts` contains normalized failure decisions,
`progress.ts` contains progress and retention policy, and `scheduler.ts` owns
single-flight execution, cancellation and retry admission. The scheduler is
executor-agnostic so API and SSH/SFTP behavior remain separate.

Desktop transfer executors are separated into API and SSH/SFTP paths. SSH/SFTP
keeps its existing non-resumable behavior. Queue metadata is persisted without
request headers, bodies, or download URLs. Items that were active when the
application closed are restored as `needs_user_action`; they are never reported
as completed or silently resumed. API downloads restored without runtime
request credentials must be added again.

The public `share.html` download is a standalone unauthenticated browser flow.
It cannot share the authenticated FileBrowser Queue state. Its download status
must remain local to that page unless a future server-backed public transfer
queue is introduced.

## Lifecycle

```text
queued -> running -> completed
queued -> running -> failed
queued -> cancelled
running -> cancelled
failed -> queued (manual retry only)
failed -> needs_user_action (non-retryable recovery decision)
needs_user_action -> queued (explicit user retry)
```

`retrying` and `needs_user_action` are reserved for explicit recovery decisions.
They must not be presented as resumable transfer support. A running item must
never be marked completed by a late callback after cancellation.

## Queue Item

Each implementation keeps the following logical fields:

| Field | Meaning |
| --- | --- |
| `id` | Unique client-side Queue identity |
| `kind` | Upload, download, archive download or download set |
| `label` | Human-readable source/destination label |
| `status` | Current lifecycle state |
| `detail` | Actionable current status text |
| `progress.completedBytes` | Bytes observed by the executor |
| `progress.totalBytes` | Total bytes, or null when unknown |
| `progress.percentage` | Percentage, or null when total is unknown |
| `progress.bytesPerSecond` | Recent measured rate, or null when not enough samples exist |
| `progress.etaSeconds` | ETA when size and rate are reliable |
| `progress.completedItems` | Completed children in a multi-file operation |
| `progress.totalItems` | Total children in a multi-file operation |
| `createdAt` / `finishedAt` | Lifecycle timestamps where supported |
| `error` | Normalized category and diagnostic detail on failure |

## Progress

Progress is updated from byte observations where the executor exposes them.
Speed uses a short time window rather than a single chunk. A transfer shorter
than the sampling window may show no speed or ETA, which is expected.

The UI should use these fallbacks:

- Unknown content length: show transferred bytes but not a percentage.
- Insufficient sample duration: omit speed and ETA rather than showing zero.
- Multi-file operation: show aggregate bytes and item counts.
- Terminal state: emit one final snapshot and release listeners, timers,
  stream readers, abort controllers and Blob references.

## Failure Decisions

| Category | Default decision |
| --- | --- |
| Network, timeout, transient 5xx | Bounded retry with exponential backoff |
| Authentication expiry | Stop and require re-authentication or token renewal |
| Permission, invalid path, validation | No automatic retry; show actionable failure |
| Conflict | `needs_user_action` unless a deterministic policy already applies |
| Missing upload source | Stop before sending and request re-add/cancel |
| Changed upload source | Stop; never silently send changed content |
| Missing download destination | Stop; do not choose an unrelated destination |
| Unknown partial data | Clean owned partial output and require user decision |
| User cancellation | Abort where supported and clean owned temporary data |

The queue does not implement chunk resume or checksum manifests. Without a
verifiable checkpoint, the safe fallback is a controlled full retransfer after
cleanup, never an undocumented append or a claim of resume support.

## History Cleanup

Active items remain visible until they reach a terminal state. Terminal history
is bounded both by age and count:

| State | Default retention | Maximum |
| --- | --- | --- |
| `completed` | 24 hours | 20 |
| `cancelled` | 24 hours | 10 |
| `failed` | 7 days | 20 |

The Queue UI provides removal of individual terminal items and a clear-history
operation. Removing an active item must first cancel it and release executor
resources. Frontend history cleanup is independent from server progress-record
cleanup. The server runs both `TransferManager.cleanup()` and the legacy
`src/backend/transfer/progress.js` cleanup on the periodic scheduler; active
records are retained and terminal records are removed after the server
retention window. Re-running cleanup is safe.

The server runs `TransferManager.cleanup()` every 15 minutes, retains active
`pending`, `uploading` and `processing` records, and removes terminal transfer
and batch records after 24 hours by default. Records that remain active without
progress for 24 hours are first marked failed with a stale-record diagnostic;
they are never silently deleted while still active. This is separate from
frontend history cleanup and is not crash recovery.

## Adding a Transfer Entry Point

New upload/download UI code must only create a Queue item and provide an
executor. It must not call an upload/download endpoint directly from a render
component or bypass Queue state updates. The executor must report progress,
return a terminal detail, classify failures, and release all resources in a
`finally` path.

Before merging a new entry point, verify:

- Toolbar, double-click, context menu and drag/drop paths use the same executor.
- API and SSH/SFTP behavior remains separated.
- Unknown-size and fast-completion transfers have sensible display fallback.
- Cancel, retry, failure and history cleanup are covered by tests.

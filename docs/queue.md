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
They must not be presented as resumable transfer support. A late callback must
not overwrite a confirmed terminal cancellation. A cancellation request alone
is not terminal: if the server committed the work first, completion can win.

### API Upload Attempts

The approved browser/desktop contract and server wiring are implemented. Final
verification passes 261 Node tests with no failures/skips, including 94 desktop
checks and all 30 server tests. The desktop TypeScript/Vite build also passes.
Fourteen native session tests pass, including actual backend cookie login,
multipart upload, cancellation, byte/download integrity, ownership, revision,
and logout checks through production native transport. Desktop hooks still use
explicit native mocks; the new fixture does not launch Tauri or dispatch the
AppHandle-dependent api_upload_paths command. See the
[final report](./review-remediation.md#final-report) for exact boundaries.

1. Capture the server origin, authenticated session, owner, Location, and destination before sending files. Desktop keeps the native session handle and request credentials in a private runtime map, not persisted Queue metadata.
2. Reserve with `POST /api/upload/batches`, using `{ path, clientAttemptId }`. Retain the returned batch ID before native/browser multipart dispatch. Send it as `X-Upload-Batch-ID` to `POST /api/upload/multiple`.
3. Poll `GET /api/progress/batch/:batchId` using the captured context. A lost upload response or failed progress request requires reconciliation of that batch, not another multipart upload.
4. Request cancellation through a separate `POST /api/progress/batch/:batchId/cancel` control request. Abort local transport where supported, but do not report server cancellation until the server reports settlement. `202`/`cancelling` is still unconfirmed.
5. Retain committed files and report the returned completed/failed/cancelled counts. `completed` may win a cancellation race; a failed cleanup is not confirmed cancellation.

Desktop moves an unconfirmed outcome to `needs_user_action` with
`uploadOutcome: "reconcile"`. With the original runtime session still available,
manual Retry checks the original batch without resending its files. After
restart or loss of that session, do not silently bind the old attempt to new
credentials or re-upload it. Review the server outcome and storage first.

The browser and desktop executors retain their separate scheduling and UI
implementations. SSH/SFTP and ordinary downloads do not acquire this server
upload reservation protocol. Updated API clients require the updated backend;
there is no fallback that treats client-only abort as confirmed cancellation.
Legacy upload endpoints remain supported for external clients, but clients
without a reservation cannot recover an unknown batch ID from a lost acceptance
response. See [upload.md](./api/upload.md) and [progress.md](./api/progress.md)
for the integrated service contract. Real deployment and platform smoke tests
remain separate from the verified local fixtures.

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
| `serverBatchId` / `clientAttemptId` | Non-secret server reservation and client attempt identity for reconciliation |
| `serverOrigin` / `ownerId` / `locationRevision` | Captured API context metadata; never a credential or permission grant |
| `uploadOutcome` | Desktop API attempt state: `reserved`, `accepted`, `reconcile`, or `settled` |
| `cancellationRequested` | Stop was requested; this flag does not prove server cleanup or cancellation |

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

The server keeps `totalSize` and `progress` numeric even when the total is
unknown: `totalSizeKnown: false` distinguishes that case from known zero bytes.
Desktop maps an unknown total to `progress.totalBytes: null` and no percentage.
Use actual `transferredSize`, not request framing or a declared file size;
`committedSize` separately describes published files. Known zero-byte work
finishes by server settlement, not division by zero. Directory-only batches
may complete with zero files and zero bytes. A byte percentage of 100 is not
proof that publication or cleanup has finished.

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
For an accepted or possibly accepted API upload, the original batch must first
be reconciled. The generic network retry rule does not authorize a duplicate
upload, including after a `404` poll or server restart.

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

The server scheduler invokes `TransferManager.cleanup()` every 15 minutes.
The implemented manager expires unused reservations after 15 minutes and makes
terminal transfer/batch records eligible for removal after 24 hours by default.
Active records and registered workers remain retained until settlement; lack
of progress alone does not fail or remove them. This includes pending,
uploading, processing, and cancelling work. This is separate from frontend
history cleanup and is not crash recovery. Server restart loses in-memory
telemetry and does not confirm an unknown upload outcome.

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

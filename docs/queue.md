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

New API uploads use one durable parent session per Queue item:

1. Capture server origin, account, Location, revision, and destination. Credentials
   and native session handles stay in runtime memory and are never persisted.
2. Read `/api/upload/sessions/config`, hash and preflight the source manifest,
   including the child limit, before starting the four-hour session lifetime.
3. Create `POST /api/upload/sessions`, register ordered manifest pages with per-chunk
   SHA-256 values, then seal the manifest before sending bytes.
4. Split files into children of at most 500. Keep same-normalized-destination files
   together and in stable manifest order. Run no more than two child batches at once.
   The UI warns that parallel work can use more resources and may reduce efficiency.
5. Upload each file with bounded chunks, `Content-Range`, and `X-Chunk-SHA256`. A lost
   response reads the same session checkpoint and continues at `uploadedOffset`.
   Completed files are skipped; only unfinished files and ranges are resumed.
6. On restart, the user explicitly resumes under the same owner/server/Location.
   Desktop reopens local paths and recomputes hashes. Browser asks the user to
   reselect sources because `File` objects are not persisted across reloads.
7. Cancellation settles through the server session. Already committed files remain;
   completion may win the cancellation race. Incomplete sessions expire after four
   hours.

Legacy Queue items with `serverBatchId` retain their original behavior: reconcile the
same in-memory batch without resending multipart data. They are not converted to
byte-range sessions. See the [Upload API](./api/upload.md) and
[Progress API](./api/progress.md) for the server-side protocol contracts.

The browser and desktop executors retain their separate scheduling and UI
implementations. SSH/SFTP and ordinary downloads do not acquire this server
upload reservation protocol. Updated API clients require the updated backend;
there is no fallback that treats client-only abort as confirmed cancellation.
Legacy upload endpoints remain supported for external clients, but clients
without a reservation cannot recover an unknown batch ID from a lost acceptance
response. See [Upload API](./api/upload.md) and [Progress API](./api/progress.md)
for the server-side contract.

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

## Pane Style Queue Window

The Pane Style floating window (`PaneWorkspaceLegacy.js`) is laid out as a compact
title bar, a totals row and a scrolling list:

- The title bar only holds the `Transfer Queue` title and the close button; it is
  also the drag handle.
- The totals row shows `done/total files · percent`, the active count and the
  need-attention count. Every value is computed from the items' `progress`
  (`completedItems`, `totalItems`, `completedBytes`, `totalBytes`); the percentage
  is `doneBytes / totalBytes`, falling back to `doneFiles / totalFiles` when the
  total byte count is zero.
- Each upload row shows `To <Location>:/<destination path>`, the file that is
  being sent right now, an animated arrow flow (running and retrying only, disabled
  under `prefers-reduced-motion`), a progress bar whose width is the real item
  percentage, and `File k/N`. A batch upload is one row; the browser uploader
  records the in-flight file in `currentFile` at the start of every file and
  moves it to the next in-flight file (or clears it) when that file settles, so
  the name changes as the batch advances. Finished rows show a single
  `Completed` label instead of a percentage and hide the raw detail text.

Button meaning:

| Button | Where | Effect |
|---|---|---|
| `Clear` | Completed or Cancelled row | Removes only this record. Uploaded files are untouched. |
| `Clear list` | Totals row | Removes every Completed and Cancelled record of any transfer kind. Running, failed and needs-action rows are kept because they may hold a resumable server session. |
| `Discard` | Failed or needs-action row with a server session | Deletes the unfinished upload session on the server, so it can no longer be resumed. Published files are kept. |
| `Remove` | Failed or needs-action row without a server session | Removes the record only. |

### Transfer kinds in the Pane queue

The Pane queue shows every record in the shared queue, not only uploads. Pane and
Classical use the same queue engine in `FileBrowser.js`; Pane only supplies the
Location and path of the window that started the transfer.

| Kind (`data-queue-kind`) | Started by | Route label | Progress source |
|---|---|---|---|
| `upload` | `Upload`, or dropping files/folders on a Pane window | `To <Location>:/<path>` | Bytes and files from the resumable upload session |
| `download` | `Download` on one file, or an archive (`tar.gz`/`zip`) of a folder or several items | `From <Location>:/<path>` | Streamed bytes against `Content-Length` |
| `download-set` | `Download` > `Queue (one file at a time)` | `From <Location>:/<path>` | Overall bytes (`baseBytes` of finished files plus the streaming file) and `completedItems/totalItems` files |
| `copy`, `move` | Dragging between Pane windows or the paste actions | `From <Location>:/<path> -> <Location>:/<path>` | Item counts from the server's `/api/files/paste` event stream |

Copy and move are recorded, not scheduled. The queue executor never runs them
(they have no job), they cannot be cancelled, and the blocking transfer panel
still shows their live detail. Their `progress.percentage` is
`resolvedItems / totalItems`. Status mapping: completed -> `completed`, partial
-> `needs_user_action`, failed or unconfirmed -> `failed`. They never auto-open
the queue window, because the transfer panel is already visible.

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

API upload sessions use verified chunk checksums and durable offsets. A client must
reconcile the same session after a lost response and may only send bytes from the
offset returned by the server. Do not append by assumption or resend completed
files. If the four-hour session expires, or its owner/Location/source manifest no
longer matches, inspect the destination before creating a new upload.

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

## Executor Integration

New upload/download UI code must only create a Queue item and provide an
executor. It must not call an upload/download endpoint directly from a render
component or bypass Queue state updates. The executor must report progress,
return a terminal detail, classify failures, and release all resources in a
`finally` path.

Toolbar, double-click, context-menu, and drag/drop entry points use the same Queue
admission path. Keep API and SSH/SFTP execution separate. Represent unknown-size
and fast-completion transfers using the progress fallbacks above, and route
cancellation, retry, and terminal cleanup through the Queue lifecycle.

For implementation steps, see [Queue Maintenance](./queue-maintenance.md).

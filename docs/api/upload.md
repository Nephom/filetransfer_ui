# Upload API

Use the resumable upload-session API below for new browser and desktop integrations.
The legacy multipart routes remain supported for existing clients. All upload,
session, reservation, progress, and cancellation routes require a current account authenticated
by the HttpOnly session cookie or `Authorization: Bearer <token>`. Authentication
finishes **before multipart parsing or staging storage**. Body/query credentials are
not accepted. Multipart metadata is not an authentication channel.
Account IDs retain their original type: numeric IDs (including administrator `0`)
and nonempty string IDs are supported, but numeric `7` does not match string `"7"`.

## Reserve Before Sending

```http
POST /api/upload/batches
Content-Type: application/json
X-Location-ID: <authorized Location ID>

{"path":"documents","clientAttemptId":"optional-client-attempt-id"}
```

`path` is a required string relative to the Location root; use `""` for that root.
`clientAttemptId`, when supplied, is a nonempty string of at most 128 characters.
No other JSON properties are accepted. JSON is limited to 20 KiB.

The response is `201 Created`:

```json
{
  "batchId": "opaque-uuid",
  "status": "reserved",
  "locationId": "default",
  "expiresAt": 1788956100000
}
```

The reservation stores the current account ID **and** username, Location revision,
and checked destination internally. It expires 15 minutes after creation; polling
and repeated reservation requests do not extend that time. At most 1,000 unclaimed
reservations can exist at once. Capacity exhaustion returns `429`.

A repeated `clientAttemptId` returns the same unclaimed, unexpired reservation only
when owner, Location, revision, and target still match. It returns `409` after claim
or a conflicting/terminal attempt. Keep the original batch ID for reconciliation.
Reservations are single-use, not durable or resumable sessions.

## Resumable Upload Sessions

An upload session is an owner- and Location-bound durable manifest. It survives a
server restart. Incomplete sessions expire **four hours after creation**; reads and
chunk uploads do not extend that deadline. Completed destination files are never
removed when the session expires.

Before hashing files, clients can request the active chunk size:

```http
GET /api/upload/sessions/config
```

The authenticated, `Cache-Control: no-store` response is `{ "chunkSize": 8388608 }`.
Built-in clients hash sources and validate the 500-file child plan before creating
the session, so manifest preparation does not consume the four-hour retention
window and oversized same-destination groups do not leave unusable sessions behind.

```http
POST /api/upload/sessions
Content-Type: application/json
X-Location-ID: <authorized Location ID>
X-Location-Revision: <captured revision>

{"path":"documents","clientAttemptId":"stable-client-attempt","chunkSize":8388608,"fileCount":2,"directoryCount":1}
```

`chunkSize` is optional for compatibility; when supplied it must match the current
server setting. If the setting changed after options were read, the server returns
`409` without reserving a session, and the client should read the options and rebuild
the manifest.

The response is `201` for a new session and `200` when the same active
`clientAttemptId`, owner, Location, revision, destination, file count, and directory
count and chunk size recover an existing session. It includes `sessionId`, `chunkSize`, and
`expiresAt`. The configured chunk size defaults to 8 MiB and is limited to 1–64 MiB.
One session can declare at most 100,000 combined files and directories. The service
admits at most 1,000 unexpired session records, caps a single manifest at 256 MiB,
and caps all unexpired manifest pages at 1 GiB; admission exhaustion returns `429`.
The server checks available staging space before sealing the manifest and preserves a
64 MiB (or 5% when smaller) free-space reserve.

Submit manifest pages in order to
`POST /api/upload/sessions/:sessionId/manifest/pages/:pageIndex`. Each page has
`fileOffset`, `directoryOffset`, up to 50 files, and up to 50 directories; JSON pages
are limited to 5 MiB. A file entry contains a client `fileId`, destination-relative
`path`, basename `name`, byte `size`, and one SHA-256 value per chunk in
`chunkHashes`. Paths must be safe Location-relative paths. File paths are sorted by
UTF-8 byte order; same-target collision entries retain their manifest order.
`POST /api/upload/sessions/:sessionId/manifest/complete` validates the declared
inventory, seals it, and creates the declared directories before file bytes are sent.

Each file chunk is a raw `application/octet-stream` request:

```http
PUT /api/upload/sessions/:sessionId/files/:fileId/chunks
Content-Range: bytes 0-8388607/12000000
X-Chunk-SHA256: <lowercase-or-uppercase-hex-sha256>
Content-Type: application/octet-stream
```

The start offset must equal the server's persisted offset, and the range length and
SHA-256 must match the sealed manifest. A successful response reports the committed
`uploadedOffset`. An offset conflict returns `409` and `expectedOffset`. After a lost
chunk response, query the session and continue from the returned offset; do not
assume the request failed or resend the whole file. Each chunk is written to staging,
verified, synced, and only then checkpointed in SQLite. Finalization verifies staged
chunks again and uses an exclusive, idempotent publication checkpoint.

`GET /api/upload/sessions` lists the authenticated owner's unexpired sessions that
still have valid Location permissions, including terminal outcomes for reconciliation.
`GET /api/upload/sessions/:sessionId` returns
the session summary and paginated file records (`offset`/`limit`, maximum 100); each
file exposes its stable `manifestHash`, `uploadedOffset`, and status, but not its
staging path or chunk hash list. The manifest hash is SHA-256 over the concatenated
binary chunk hashes followed by the UTF-8 decimal file size. It lets a reselected
source be matched without returning a large hash array on every status query.

Finalize a fully received file with
`POST /api/upload/sessions/:sessionId/files/:fileId/complete`, then finalize the
parent with `POST /api/upload/sessions/:sessionId/complete`. Repeating either
finalize request is safe. Cancel with `POST /api/upload/sessions/:sessionId/cancel`;
the server waits for active chunk/publication work to settle. Already completed
files and directories remain in place. A subsequent resume skips completed files
and sends only unfinished files and byte ranges. Browser clients must reselect the
source after page reload; Desktop clients reopen the captured local paths and
recompute the manifest. Both clients verify the current source against the original
chunk checksums before continuing.

The built-in clients split file inventories into children of at most 500 files and
run at most two children concurrently. They keep files with the same normalized
destination together and sort by destination path. Parallel child uploads can use
more client, server, network, and staging/storage resources, and shared destination
locks can make them less efficient; the UI warns before starting large uploads.

## Multipart Upload

```http
POST /api/upload/multiple
X-Location-ID: <authorized Location ID>
X-Location-Revision: <optional current opaque revision>
X-Upload-Batch-ID: <optional reserved batch ID>
Content-Type: multipart/form-data; boundary=<generated by client>
```

| Field | Meaning |
| --- | --- |
| `files` | Repeated file parts, up to 1,000 files |
| `path` | Relative destination directory, defaults to the reservation path or root |
| `filePaths[]` | Optional relative path for each file, in file order |
| `directoryPaths[]` | Optional relative directories, including empty directories |
| `locationId` | Legacy Location selector; must agree with the header/reservation |

`filePaths` and `directoryPaths` without brackets are also supported. If file paths
are supplied, their count must equal the file count. Each metadata array is limited
to 1,000 entries. Scalar fields must not repeat. A request needs at least one file
or directory. Metadata may precede or follow the files; publication waits for the
entire multipart parser and all staged writes to settle.

When `X-Location-Revision` is supplied, the server checks it against the selected
Location before receiving multipart bytes and rejects a mismatch with `409`.
Select that Location with `X-Location-ID` (or the legacy query selector/default),
not a later multipart field. Reservation and progress/cancellation requests honor
the same optional revision header. Root/revision checks also run after parsing and
before publication, so an upload cannot cross a runtime Location replacement.

The current `fileSystem.maxFileSize` is read for every request and enforced per file.
Exactly that many bytes and zero-byte files are valid. There is no additional
aggregate file-byte limit. All routes enforce file/count limits, including legacy
single-progress uploads. Multipart fields are limited to 16 KiB each, field names
to 100 characters, 2,010 fields, 3,010 parts, and 32 MiB of aggregate field metadata.
Unknown fields, body credentials, duplicate scalars, extra single-upload files,
truncated parts, and malformed multipart requests are rejected. `Content-Length` is
not required and is never treated as a file size.

When `security.enableFileUploadSecurity` is true, parsed original filenames and
effective destination filenames reject the existing case-insensitive extension
denylist: `.exe`, `.bat`, `.cmd`, `.com`, `.pif`, `.scr`, `.vbs`, `.js`, `.jar`,
`.php`, `.asp`, `.aspx`, `.jsp`, `.sh`, `.ps1`, `.py`, and `.rb`. Filename overrides
and folder metadata cannot bypass this check. Rejected requests clean all owned
staging before dispatch. This policy adds no 100 MiB size cap; the configured
per-file limit remains authoritative. The flag is read for each upload validation.

For a file batch, the server returns `202 Accepted` after parsing, metadata/path
validation, and registration of **all** pending children:

```json
{
  "success": true,
  "batchId": "opaque-uuid",
  "message": "Upload accepted. Poll for progress."
}
```

Publication then runs in the background. With a reservation, its batch ID also
allows progress/cancellation while multipart bytes are arriving. Without one,
clients learn the ID only in the acceptance response. An acceptance response lost
in transit does not cancel accepted server work. Do not retransmit the batch to
recover from an unsuccessful progress poll.

Directory-only requests preserve the synchronous `200` response fields:

```json
{
  "success": true,
  "batchId": "opaque-uuid",
  "locationId": "default",
  "message": "Folders uploaded successfully.",
  "folders": 2
}
```

## Existing Endpoints

| Endpoint | File field | Response |
| --- | --- | --- |
| `POST /api/upload` | Repeated `files` | Same batch/directory behavior as `/upload/multiple` |
| `POST /api/upload/multiple` | Repeated `files` | `202` batch acceptance, or `200` directory-only result |
| `POST /api/upload/single` | One `file` | `200` after publication, with `transferId` and `file` |
| `POST /api/upload/progress` | One `file` | Same synchronous result, with measured counters |
| `POST /api/upload/single-progress` | One `file` | `202` with `transferId` after full multipart validation |

Single-file routes accept `path`, `locationId`, and optional `fileName`. Their legacy
query selectors remain supported. UTF-8 and literal percent characters in multipart
filenames are preserved; query decoding is performed once by Express. Responses
retain the requested original `file.name` and expose the actual collision-resolved
Location-relative `file.path` and measured `file.size`.

## Storage And Cleanup

All final paths and directory targets use the configured Location's checked path
policy. Absolute paths, traversal components, and symbolic links below a Location
root are rejected. Authorization and Location revision are checked again before
publication and after the output stream settles.

The server stages files in a private request directory. Parser, metadata,
authorization, storage, and transport failures await staged stream settlement and
cleanup. Accepted work owns the staged directory even if sending its response
fails. Periodic cleanup excludes active stages; failed cleanup is reported as a
failure and leaves abandoned staging eligible for a later sweep.

Resumable sessions use a separate private staging directory per session and file.
The server streams each chunk to an owned incoming file, verifies its expected
length/hash, syncs it, writes it at the recorded offset, syncs the partial file, and
only then advances the SQLite checkpoint. On restart, bytes beyond the last
checkpoint are truncated; a missing/truncated checkpoint file safely resets that
file to offset zero. Finalization copies to a hidden, cache-excluded temporary file
beside the destination, verifies it, then atomically links the complete file into an
exclusive collision-resolved name. Completed file staging is removed immediately.
Unfinished session staging and checkpoints expire after four hours and are cleaned
on startup and every five minutes; session expiry never removes committed outputs.

Destination creation uses exclusive `wx` opening under the shared operation locks.
Existing names are retried as `name_(1).ext`, `name_(2).ext`, and so on; `.tar.gz`
keeps the established `name_(1).tar.gz` convention. Only a successfully reserved,
uncommitted output can be removed by that upload. The locks remain held through
stream settlement and failure cleanup. Existing or committed outputs from other
uploads are never removed to resolve a collision or failure.

These are process-local guarantees for cooperating operations, not an OS sandbox
against hostile external writers, other server processes, or other NFS clients.
Partial destination files may exist while publication is in progress; completion
is the commit boundary. A post-commit cache-refresh failure is a warning and does
not turn a successful upload into a re-upload request.

## Cancellation And Errors

Use `POST /api/progress/batch/:batchId/cancel` or
`POST /api/progress/:transferId/cancel`. Cancellation aborts active streams and
shared-lock waits, removes queued staged work, and waits for owned cleanup.
Committed outputs, including already created directories, remain in place.
Cancelling a receiving child interrupts the multipart request because its parser
can no longer produce a valid complete batch; other uncommitted children fail.
Cancelling a pending/processing child after acceptance leaves siblings running.

Cancellation can lose a race with completion. A cleanup I/O failure returns a failed
state rather than claiming confirmed cancellation. See [progress.md](./progress.md)
for phases, counters, partial outcomes, safe polling, and retention.

Errors use safe JSON, without internal paths, stack traces, or raw credentials.
Typical HTTP statuses are `400` for invalid metadata/multipart, `401` for failed
authentication, `403` for denied access, `404` for unknown/not-owned records, `409`
for consumed/mismatched reservations or changed Location state, `413` for limits,
`429` for reservation capacity, and `5xx` for storage/service failure.

## Server Integration

`UploadAPI` registers upload, reservation, GET progress, and POST cancel routes in
one router. Mount `uploadApi.getRouter()` at `/api`; do not leave old inline progress
routes ahead of this router. Retain
`setLocationManager(manager, cacheResolver, locationPermissionManager)` and
`setCache(cache)`. Cross-origin integration must allow `Authorization`,
`Content-Type`, `X-Location-ID`, `X-Location-Revision`, `X-Upload-Batch-ID`,
`Content-Range`, and `X-Chunk-SHA256` as appropriate, along with cookie credentials.
Server wiring is maintained separately from this module. Do not add the legacy security
middleware's independent 100 MiB check to this parser's validated requests.

`await uploadApi.waitForIdle()` waits for authenticated upload requests already
entering intake, accepted workers, cache refresh, and cleanup settlement. It does
not cancel jobs, block new requests, wait for unused reservations, or assert that
every job succeeded. Stop new admission before using it as a shutdown barrier.
Do not call it while holding filesystem locks needed by those workers.

For runtime Location replacement, the parent can swap managers and use shared
operation locks on the old/new canonical roots as a publication/cache-close
barrier. Upload file publication and its post-commit cache refresh stay under the
same destination lock. Directory cache refresh also holds a destination lock.
Cache references are tied to the resolved context and checked across asynchronous
cache resolution; old absolute paths cannot be sent to a replacement cache. A
post-commit runtime change skips stale cache refresh with a warning, not a file
rollback. A root-lock barrier alone does not drain multipart reception; use the
admission gate and `waitForIdle()` when complete intake/worker settlement is needed.

# File Transfer API Reference

This is the contract reference for the Node.js service. Client changes must follow this document rather than infer behaviour from server implementation.

Final integration snapshot (2026-09-09): the account, filesystem, upload,
progress, share, settings, and browser modules are integrated in server.js.
The final full Node run passes 261 tests with no failures/skips, including all
30 server tests. Fourteen native session tests pass, including production
native transport against actual backend routes with isolated services.
This is not live Tauri/AppHandle dispatch or a production deployment. See the
[final report](../review-remediation.md#final-report) for evidence and limits.

## Conventions

- Base URL is the configured HTTP or HTTPS server URL. The Ubuntu desktop client requires a server address and HTTPS port separately; its port defaults to `9443` and it does not embed a deployment address.
- Protected endpoints accept the HttpOnly `filetransfer_session` cookie or `Authorization: Bearer <JWT>`. The shared authenticator prefers a supplied session cookie; an invalid cookie does not fall through to Bearer authentication.
- Paths are relative to the selected Location root and use `/` separators. Send `X-Location-ID` independently of authentication. `GET /api/locations` exposes an opaque `revision`; optional `X-Location-Revision` is checked against its associated Location and stale values return `409`.
- Successful JSON responses normally include `success: true`. Errors return an HTTP error status and an `error` or `message` field.
- File and archive responses are binary streams and include `Content-Disposition: attachment`.

## Authentication

| Method | Endpoint | Request | Success |
|---|---|---|---|
| POST | `/auth/login` | `{ "username", "password" }` | Sets the HttpOnly session cookie; `{ "success": true, "user": { "id", "username", "role", "email", "permissions", "lastLogin" } }`. Current service does not return a token in JSON. |
| POST | `/auth/logout` | None | Clears the session cookie; `{ "success": true }`. This is not global JWT revocation. |
| POST | `/auth/register` | Registration payload | Registered user result |
| POST | `/auth/change-password` | Current and new password payload | Success result |
| POST | `/auth/verify` | Session cookie or Bearer token | Current account verification result |
| POST | `/auth/forgot-password` | `{ "username" }` | Password reset request result |
| POST | `/auth/reset-password` | Reset token and password payload | Success result |

The desktop Location client keeps cookies in an origin-bound native session.
Its in-memory `"cookie"` marker is UI state, never a Bearer credential. Real
Bearer clients remain supported. Account ID `0` is valid for the configured
administrator; authorization checks the current immutable ID/username pair,
not a matching username or stale token role alone.

`POST /auth/change-password` requires the current password, saves the new
password, and clears the response session cookie on success. Config-backed
administrator password writes use configManager and the same serialized
configuration-change queue as settings/admin configuration updates. This does
not claim revocation of every previously issued JWT; clients must sign in again.

## File Browsing and Search

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/files?path=&offset=&limit=&sort=&order=` | List one directory. Returns `{ success, files, currentPath, pagination? }`. A file has `name`, `path`, `isDirectory`, `size`, and `modified`. `sort` accepts `name`, `modified`, `size`, or `directory`; `order` accepts `asc` or `desc`. Directory-first is always applied before the selected field, names use case-insensitive natural ordering, and sorting occurs before pagination. The default is `sort=name&order=asc`. |
| POST or GET | `/api/files/search` | Search indexed files. POST body is `{ "query" }`; GET uses `?query=`. |
| GET | `/api/files/content/*` | Read text file content. |
| GET | `/api/files/cache-stats` | Retrieve cache statistics. |
| GET | `/api/files/index-status` | Retrieve index state. |
| POST | `/api/files/rebuild-index` | Start an index rebuild. |
| POST | `/api/files/refresh-cache` | Refresh cache; optional `{ "directoryPath" }`. |

## Upload and Progress

Use `POST /api/upload/multiple` for all new client uploads. It streams the multipart body and is the supported large-file path.

| Method | Endpoint | Request | Success |
|---|---|---|---|
| POST | `/api/upload/batches` | JSON `{ "path": "relative/directory" }`, optional `clientAttemptId` string; use `""` for root | `201`, `{ batchId, status: "reserved", locationId, expiresAt }` |
| POST | `/api/upload/multiple` | Multipart `files`, optional matching `filePaths[]`, `directoryPaths[]`, and `path`; optional `X-Upload-Batch-ID` reservation header | `202` for validated file batches; `200` for directory-only work, with `batchId` |
| POST | `/api/upload/single-progress` | One multipart `file`, optional `fileName`, optional `path` | `202`, `{ "transferId" }` |
| GET | `/api/progress/:transferId` | Captured owner/Location authentication | Safe transfer status and measured byte counters |
| GET | `/api/progress/batch/:batchId` | Captured owner/Location authentication | Safe batch status, counters, and child records |
| POST | `/api/progress/:transferId/cancel` | Captured owner/Location authentication | Safe current transfer state after cancellation handling |
| POST | `/api/progress/batch/:batchId/cancel` | Captured owner/Location authentication | Safe current batch state after cancellation handling |

These routes are implemented by `UploadAPI` mounted at `/api`, with current
Location/permission/cache dependencies. Obsolete inline progress handlers are
removed. CORS allows credentials and the Authorization, Content-Type,
X-Location-ID, X-Location-Revision, and X-Upload-Batch-ID headers.
Progress/cancel responses use `Cache-Control: no-store`, `200` normally, or
`202` while still `cancelling`. Cancellation requests are idempotent; neither
`202` nor client transport abort confirms cleanup. Completion may win the race,
and committed outputs remain present.

Authentication and supplied Location revision checks precede multipart parsing
and staging. Body/query credentials are not accepted. The reservation is owned
by the current account ID/username
and stored Location/revision. It is single-use and expires after 15 minutes if
unclaimed. `clientAttemptId` is optional, nonempty, and at most 128 characters;
matching unclaimed reservations can be recovered, not claimed uploads resumed.
Progress/cancel authorization rechecks the current owner and stored Location
permissions/revision. Missing or not-owned records return `404`, denied access
`403`, and changed Location state `409`. A request header cannot reassign a job.
Owner IDs preserve their type, including numeric administrator `0` and ordinary
numeric account IDs; string/numeric lookalikes are not interchangeable.

The configured per-file size limit and multipart metadata/count limits are
active. When upload security is enabled, the existing extension denylist checks
both parsed and effective filenames; there is no extra hidden 100 MiB cap.
An already aborted request is detected even if it closed before parser listeners
were installed. Cleanup waits for owned streams/files to settle.

| Progress field | Implemented module meaning |
|---|---|
| `status` / `phase` | Lifecycle outcome and current stage; these determine settlement, not percentage |
| `totalSize` / `totalSizeKnown` | Numeric content-byte total (`0` while unknown) plus a boolean distinguishing unknown from known zero bytes |
| `transferredSize` | Measured file-content bytes received/staged, excluding multipart framing; may include discarded bytes |
| `committedSize` | Measured bytes published successfully |
| `progress` | Numeric 0-100 percentage, rounded to two decimals; unknown totals give `0`, known zero work gives `100` only on completion |
| `totalFiles`, `successCount`, `failedCount`, `cancelledCount`, `pendingCount` | Complete validated batch inventory; pending includes all nonterminal children |
| `uploadingCount` / `processingCount` | Subsets of pending children, not extra files |
| `files` | Allowlisted child transfer objects; no roots, owner credentials, private worker controls, or raw internal errors |

For known positive totals, percentage is bounded `transferredSize / totalSize * 100`;
byte counters are not padded to a declared total. At inventory completion,
`totalFiles = successCount + failedCount + cancelledCount + pendingCount`.
During intake the inventory/total may still be unknown. See
[progress.md](./progress.md) for full transfer/batch schemas and safe errors.

Progress records are in-memory telemetry, not durable transfer sessions.
Clients should poll only while an operation is active and must tolerate a
terminal record disappearing after the server retention window. Client Queue
history cleanup and server progress cleanup are separate concerns.

`filePaths[]` preserves folder hierarchy. Each value must correspond to a submitted `files` part and must be relative to the selected local folder. Terminal batch states are `completed`, `partial_fail`, `failed`, `cancelled`, and `expired`. Keep the reserved batch ID if acceptance or polling fails. Retry/reconcile the original record, not the multipart upload. See [upload.md](./upload.md) for preserved legacy routes, file/metadata limits, exclusive filename allocation, and owned cleanup.

## Downloads and Archives

Authenticated clients must enqueue upload and download operations before
starting them. Browser fallback downloads are not resumable. Public
`/api/share/:shareToken/download` requests from `share.html` are intentionally
outside the authenticated Queue and expose only that page's local status.

| Method | Endpoint | Request | Success |
|---|---|---|---|
| GET | `/api/files/download/*` | Relative file path in wildcard segment | Binary single-file stream |
| POST | `/api/archive` | `{ "items": [{ "name", "isDirectory", "path"? }], "currentPath": "relative/path", "format": "zip", "sessionName"? }`; `format` also accepts `tar.gz` | ZIP or TAR.GZ stream. `sessionName` is supplied by nFterm only for archives downloaded into LOCAL; WebUI does not use it. |

Use `/api/files/download/*` only for exactly one regular file. Use `/api/archive` for a directory or more than one item. `items[].path` is optional and is the full relative item path returned by search; it lets an archive request include search results from their actual parent directory. If a client mistakenly sends a directory to the single-file endpoint, the server returns `400` with an actionable message directing it to the archive route. Clients must surface the returned JSON error message, not only `HTTP 400`. Archive filenames use local server time in `YYYY-MM-DD_HH_mm_ss` form and are returned through both `filename` and UTF-8 `filename*` in `Content-Disposition`.

## File Mutations

| Method | Endpoint | Request |
|---|---|---|
| POST | `/api/folders` | `{ "folderName", "currentPath" }` |
| POST | `/api/files/directory` | Directory operation payload |
| POST | `/api/files` | File creation/upload-compatible payload |
| POST | `/api/files/create` | File creation payload |
| PUT | `/api/files/rename` | `{ "oldPath": "actual/parent/name", "newName": "basename" }`; legacy `oldName`/`currentPath` remain supported |
| DELETE | `/api/files/delete` | `{ "items": [{ "name", "isDirectory", "path"? }], "currentPath"? }`; item path is Location-relative and must match its basename |
| POST | `/api/files/paste` | `items`, `operation` (`copy` or `move`), `targetPath`, optional source/target Location IDs and revisions |
| POST | `/api/files/copy` | `sourcePath`, `destinationPath`, optional source/target Location IDs and revisions |
| POST | `/api/files/move` | `sourcePath`, `destinationPath`, optional source/target Location IDs and revisions |

The server derives rename's destination from the actual source parent and
restricts `newName` to a basename. Legacy fields remain supported; if both name
and full path are supplied, they must agree. Numeric names/oldPath, invalid
currentPath types, and null delete items return `400`, not uncaught path/string
errors. All previously failing malformed-name tests now pass.

Delete preflights the selection and returns exact `results[].path`/`success`,
`deletedItems`, and `deletedCount`. A partial delete uses `207` with
`success: false`; HTTP success status alone does not confirm every item.
Copy/move/paste preflight checked trees and reject root mutation, same-object
aliases, descendants, and incompatible operands before mutation. Shared locks
cover copy through source deletion. Paste preserves per-item outcomes and
copied-but-not-moved failures; do not infer success from processed names or
retry an unconfirmed move automatically. These are process-local guarantees.

### Scoped Revisions

Copy/move/paste accept optional JSON `sourceLocationId` and `targetLocationId`
(`destinationLocationId` remains a target alias), with optional
`sourceLocationRevision` and `targetLocationRevision`. Send each revision
beside the ID from which it was captured:

```json
{
  "sourcePath": "reports/a.txt",
  "destinationPath": "archive/a.txt",
  "sourceLocationId": "source",
  "sourceLocationRevision": "opaque-source-revision",
  "targetLocationId": "archive",
  "targetLocationRevision": "opaque-target-revision"
}
```

`X-Location-Revision` applies only to the request's selected Location, not both
roots. Body revisions apply only to their associated source/target IDs. Omitted
IDs fall back to the request Location; omitted revisions preserve legacy
requests but do not bypass current permissions or checked paths. Any supplied
stale revision returns `409` before mutation. Refresh Location metadata and
reselect the intended files rather than blindly replaying a stale operation.

## Sharing

| Method | Endpoint | Authentication | Purpose |
|---|---|---|---|
| POST | `/api/files/share` | Required | Create a time-limited file share link. |
| GET | `/api/files/shares` | Required | List current user's share links. |
| DELETE | `/api/files/share/:shareToken` | Required | Revoke a share link. |
| GET | `/api/files/share/:shareToken/info` | Required | Get full share metadata. |
| GET | `/api/share/:shareToken/info` | No | Get public safe share metadata. |
| GET | `/api/share/:shareToken/download` | No account session | Download a passwordless shared file. Password query parameters are rejected. |
| POST | `/api/share/:shareToken/download` | No account session | Download with JSON `{ "password": "..." }`; credentials must be in the body, never the URL. |

The implemented share router accepts POST JSON up to 16 KiB. Creation/list/info
metadata uses `hasPassword`, not a password or hash. Protected-link metadata
reports `directDownloadMethod: "POST"` and `supportsDirectDownload: false`;
desktop uses the share page rather than presenting a protected link as a bare
passwordless download URL.

Admission is one conditional database update after credential and file checks,
rechecking active state, expiry, and remaining count. Each admitted GET/POST
body transfer consumes one count, including each Range request; a later stream
failure or disconnect does not refund it. HEAD consumes no count and does not
bypass credential/file checks. Responses use no-store/no-referrer policies.
Share creation also checks optional `X-Location-Revision` against the selected
Location. It rechecks the captured root and permission-runtime identity across
asynchronous permission/file/password work, including immediately before
insertion. A stale header or changed root/runtime returns `409` without creating
a share for a replacement Location. Current and omitted revision headers remain
supported. These HTTP regressions pass in the final full suite.

## Administration and TLS

Configuration, cache clear, service restart, settings writes, and TLS management require the current administrator identity. User/Permission Role management uses staff gates with additional target/role restrictions; the `/api/admin/` prefix does not itself mean that every route rejects superusers. TLS management routes are under `/api/admin/ssl`: `status`, `generate`, `renew`, `sans`, `sans/add`, `sans/:san`, and `download/ca`.

### Roles

A Role is a named, reusable permission matrix (per-Location capabilities) that can be assigned to a user via `roleId`, instead of repeating the same `locationPermissions` on every user. A user's own `locationPermissions`, if set, still override the assigned Role on a per-Location basis, so a Role covers the common case while individual exceptions remain possible. The WebUI presents the user's stored global `permissions` as fallback permissions and uses them only when no Permission Role is assigned.

| Method | Endpoint | Request | Success |
|---|---|---|---|
| GET | `/api/admin/roles` | None | `{ success, roles, locations, capabilities }` -- each Role also includes `assignedUserCount`; `capabilities` is the full list of grantable capabilities (`list`, `read`, `upload`, `write`, `delete`, `rename`, `mkdir`, `copy`, `move`, `share`); `locations` is every configured Location (including disabled ones) for building a permission matrix UI. |
| POST | `/api/admin/roles` | `{ "name", "description"?, "locationPermissions": { "<locationId>": ["<capability>", ...] } }` | `{ success, message, role }` |
| PUT | `/api/admin/roles/:id` | Same shape as POST; any field omitted is left unchanged | `{ success, message, role }` |
| DELETE | `/api/admin/roles/:id` | None | `{ success, message, unassignedUsers }` -- also clears `roleId` from any user that referenced the deleted Role, reverting them to their individual permissions. |

`POST /api/admin/users` and `PUT /api/admin/users/:username` additionally accept an optional `roleId` field to assign or clear (`roleId: ""` or `null`) a user's Role.

The implemented account-update allowlist makes existing `username` and `id`
immutable: requests cannot change either value. Supported editable fields are
validated before in-memory mutation or persistence. This is not an account
migration or a repair of existing production records.

`POST /api/admin/users/bulk` accepts `{ "usernames": ["..."], "changes": { "roleId"?, "active"? } }`. The WebUI uses this endpoint to assign or clear a Permission Role and to change active status. The server revalidates every target and returns a job ID for polling with `GET /api/admin/users/bulk/:jobId`.

### Settings And Lifecycle

`GET /api/settings` requires authentication. `PUT /api/settings` uses
`requireAdmin` and accepts a nonempty object containing only boolean
`enableRateLimit`, `enableSecurityHeaders`, `enableInputValidation`,
`enableFileUploadSecurity`, `enableRequestLogging`, and `enableCSP` fields.
Unknown fields/nonboolean values return `400`. Successful writes save and
refresh security handlers immediately; save failures restore previous values.
The response is `{ success: true, message }`; it does not include `updatedFields`.

Settings/admin configuration writes share a serialized queue. Admin config
validates before mutation, rolls back failed saves, and refreshes supported
Location/security runtime only after a successful save. Its response includes
actual `updatedFields`, `needsRestart`, and `restartRequiredFields`. Server,
JWT-secret, SSL, and non-Location filesystem settings retain their returned
restart requirements; clients must use the response rather than guess.

The enabled file limiter runs before file/upload/folder/archive routes
(50 requests/minute; the 51st request is limited). Turning the flag off restores
access. Public cache statistics omit the internal storagePath.

Importing server.js exports the app without automatically starting listeners,
loading runtime configuration, or installing process handlers; direct execution
uses the require.main guard. Tests replace persistent-service dependencies before
import. Startup checks generated browser readiness and binds HTTP/HTTPS to the
configured server.host; bind errors are not reported as readiness.

`POST /api/admin/service/restart` validates browser assets before stopping work,
rejects conflicting runtime changes, and returns an initiation response, not a
healthy-replacement guarantee. It stops new storage work, drains requests,
uploads, initializers and all Location caches, closes the database, and waits
for the child `spawn` event before exiting. Failure releases the restart lock.
Tests exercise the actual route with mocked process effects; no live production
restart is claimed. Restart never compiles browser assets.

## Logging

Request-derived user operations are stored in `logs/{IPv4-with-underscores}.log`. Entries include timestamp, level, operation, request information when available, and authenticated user information. IPv6 request addresses are intentionally excluded from operation logs. Server-only events remain in `server.log`.

## Error Handling

Use the HTTP status first, then display the response's `error.message`, `error`, or `message` field. Upload-specific structured codes are documented in [error-codes.md](./error-codes.md). Do not assume every older endpoint returns identical error shapes.

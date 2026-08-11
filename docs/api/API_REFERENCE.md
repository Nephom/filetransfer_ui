# File Transfer API Reference

This is the contract reference for the Node.js service. Client changes must follow this document rather than infer behaviour from server implementation.

## Conventions

- Base URL is the configured HTTP or HTTPS server URL. The Ubuntu desktop client requires a server address and HTTPS port separately; its port defaults to `9443` and it does not embed a deployment address.
- Protected endpoints require `Authorization: Bearer <JWT>`.
- Paths are relative to the configured storage root and use `/` separators.
- Successful JSON responses normally include `success: true`. Errors return an HTTP error status and an `error` or `message` field.
- File and archive responses are binary streams and include `Content-Disposition: attachment`.

## Authentication

| Method | Endpoint | Request | Success |
|---|---|---|---|
| POST | `/auth/login` | `{ "username", "password" }` | `{ "success", "token", "user": { "username", "role" } }` |
| POST | `/auth/register` | Registration payload | Registered user result |
| POST | `/auth/change-password` | Current and new password payload | Success result |
| POST | `/auth/verify` | Bearer token | Token/user verification result |
| POST | `/auth/forgot-password` | `{ "username" }` | Password reset request result |
| POST | `/auth/reset-password` | Reset token and password payload | Success result |

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
| POST | `/api/upload/multiple` | Multipart fields: `files` (one or more), optional `filePaths[]` (matching relative paths), optional `path` | `200` or `202`, `{ "batchId" }` |
| POST | `/api/upload/single-progress` | One multipart `file`, optional `fileName`, optional `path` | `202`, `{ "transferId" }` |
| GET | `/api/progress/:transferId` | None | One transfer's status and byte progress |
| GET | `/api/progress/batch/:batchId` | None | `{ batchId, status, totalFiles, successCount, failedCount, pendingCount, totalSize, transferredSize, progress, files }` |

`filePaths[]` preserves folder hierarchy. Each value must correspond to a submitted `files` part and must be relative to the selected local folder. Terminal batch states are `completed`, `partial_fail`, and `failed`.

## Downloads and Archives

| Method | Endpoint | Request | Success |
|---|---|---|---|
| GET | `/api/files/download/*` | Relative file path in wildcard segment | Binary single-file stream |
| POST | `/api/archive` | `{ "items": [{ "name", "isDirectory", "path"? }], "currentPath": "relative/path", "format": "zip" | "tar.gz", "sessionName"? }` | ZIP or TAR.GZ stream. `sessionName` is supplied by nFterm only for archives downloaded into LOCAL; WebUI does not use it. |

Use `/api/files/download/*` only for exactly one regular file. Use `/api/archive` for a directory or more than one item. `items[].path` is optional and is the full relative item path returned by search; it lets an archive request include search results from their actual parent directory. If a client mistakenly sends a directory to the single-file endpoint, the server returns `400` with an actionable message directing it to the archive route. Clients must surface the returned JSON error message, not only `HTTP 400`. Archive filenames use local server time in `YYYY-MM-DD_HH_mm_ss` form and are returned through both `filename` and UTF-8 `filename*` in `Content-Disposition`.

## File Mutations

| Method | Endpoint | Request |
|---|---|---|
| POST | `/api/folders` | `{ "folderName", "currentPath" }` |
| POST | `/api/files/directory` | Directory operation payload |
| POST | `/api/files` | File creation/upload-compatible payload |
| POST | `/api/files/create` | File creation payload |
| PUT | `/api/files/rename` | `{ "oldName", "newName", "currentPath" }` |
| DELETE | `/api/files/delete` | `{ "items": [{ "name", "isDirectory" }], "currentPath" }` |
| POST | `/api/files/paste` | `{ "items", "operation": "copy" | "move", "targetPath" }` |
| POST | `/api/files/copy` | Copy payload |
| POST | `/api/files/move` | Move payload |

## Sharing

| Method | Endpoint | Authentication | Purpose |
|---|---|---|---|
| POST | `/api/files/share` | Required | Create a time-limited file share link. |
| GET | `/api/files/shares` | Required | List current user's share links. |
| DELETE | `/api/files/share/:shareToken` | Required | Revoke a share link. |
| GET | `/api/files/share/:shareToken/info` | Required | Get full share metadata. |
| GET | `/api/share/:shareToken/info` | No | Get public safe share metadata. |
| GET | `/api/share/:shareToken/download` | No | Download a shared file; optional `?password=`. |

## Administration and TLS

Admin-only routes are `/api/admin/users`, `/api/admin/roles`, `/api/admin/config`, `/api/admin/cache/clear`, and `/api/admin/service/restart`, including their documented REST sub-routes. TLS management routes are under `/api/admin/ssl`: `status`, `generate`, `renew`, `sans`, `sans/add`, `sans/:san`, and `download/ca`.

### Roles

A Role is a named, reusable permission matrix (per-Location capabilities) that can be assigned to a user via `roleId`, instead of repeating the same `locationPermissions` on every user. A user's own `locationPermissions`, if set, still override the assigned Role on a per-Location basis, so a Role covers the common case while individual exceptions remain possible.

| Method | Endpoint | Request | Success |
|---|---|---|---|
| GET | `/api/admin/roles` | None | `{ success, roles, locations, capabilities }` -- `capabilities` is the full list of grantable capabilities (`list`, `read`, `upload`, `write`, `delete`, `rename`, `mkdir`, `copy`, `move`, `share`); `locations` is every configured Location (including disabled ones) for building a permission matrix UI. |
| POST | `/api/admin/roles` | `{ "name", "description"?, "locationPermissions": { "<locationId>": ["<capability>", ...] } }` | `{ success, message, role }` |
| PUT | `/api/admin/roles/:id` | Same shape as POST; any field omitted is left unchanged | `{ success, message, role }` |
| DELETE | `/api/admin/roles/:id` | None | `{ success, message, unassignedUsers }` -- also clears `roleId` from any user that referenced the deleted Role, reverting them to their individual permissions. |

`POST /api/admin/users` and `PUT /api/admin/users/:username` additionally accept an optional `roleId` field to assign or clear (`roleId: ""` or `null`) a user's Role.

## Logging

Request-derived user operations are stored in `logs/{IPv4-with-underscores}.log`. Entries include timestamp, level, operation, request information when available, and authenticated user information. IPv6 request addresses are intentionally excluded from operation logs. Server-only events remain in `server.log`.

## Error Handling

Use the HTTP status first, then display the response's `error.message`, `error`, or `message` field. Upload-specific structured codes are documented in [error-codes.md](./error-codes.md). Do not assume every older endpoint returns identical error shapes.

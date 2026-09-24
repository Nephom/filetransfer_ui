# Upload API Errors

Upload routes return safe JSON errors. `error.code` is the HTTP status code; messages
are intentionally generic and never include absolute staging paths, raw filesystem
errors, credentials, or stack traces. A resumable chunk offset conflict additionally
returns the server's authoritative `expectedOffset` at the top level.

```json
{
  "success": false,
  "expectedOffset": 8388608,
  "error": {
    "code": 409,
    "message": "Upload state or Location changed"
  }
}
```

## HTTP Statuses

| HTTP status | Meaning | Client action |
|---|---|---|
| `400` | Invalid path/manifest/range, malformed multipart, unsupported credential fields, or checksum mismatch | Correct the request; do not retry identical invalid data |
| `401` | Missing, invalid, or expired authentication | Sign in again as the session owner |
| `403` | Current account lacks upload/write permission, or Location header does not match the session | Recheck account and Location access |
| `404` | Session/file/batch is unknown or belongs to another account | Do not create a replacement upload automatically; inspect the destination and current owner |
| `409` | Location/revision changed, session already settled, chunk offset differs, or configured chunk size changed after options lookup | For an offset conflict, GET the session and continue from its checkpoint; for stale options, GET `/api/upload/sessions/config` and rebuild before creating a session |
| `410` | Resumable session expired; unfinished sessions expire four hours after creation | Inspect the destination; a new session requires an explicit user decision |
| `413` | Per-file size, legacy multipart file-count, or request/manifest metadata limit exceeded | Reduce file size or split the legacy multipart request; resumable manifests are paged |
| `429` | Active session or manifest-storage admission capacity reached | Retry later after session capacity is released; do not resend accepted chunks blindly |
| `507` | Staging or destination storage has insufficient free space | Free or provide storage space, then resume the same session if it is still active |
| `5xx` | Unexpected server/database/filesystem failure | Reconcile the same session and its offsets before retrying unfinished work |

Legacy `POST /api/upload/multiple` and `/api/upload` remain compatible and continue
to reject more than 1,000 file parts in a single request. The previous custom numeric
errors `301`, `302`, `304`, `401` (disk full), `402`, and `403` (batch missing) are
not current upload error codes; use the HTTP status and response shape above.

## Resumable Chunk Recovery

Each chunk request includes `Content-Range` and `X-Chunk-SHA256`. The server accepts
only the exact next range in the manifest. If the response is lost:

1. GET `/api/upload/sessions/:sessionId?offset=<fileIndex>&limit=1`.
2. Read the file's `uploadedOffset` and `status`.
3. Skip the file if its status is `completed`; otherwise send the next chunk starting
   at that offset.
4. Never infer that a chunk failed from a network error, and never restart the whole
   file when the session remains valid.

If a local file/folder is reselected after a Browser reload or Desktop restart, the
client recomputes per-chunk SHA-256 and compares the manifest before sending more
bytes. A changed/missing source requires a user decision. Completed files and
directories are not rolled back when another child is cancelled or incomplete.

## Cancellation

`POST /api/upload/sessions/:sessionId/cancel` waits for active chunk streams and
publication work to settle. The server's resulting `completed` status wins if all
files commit before cancellation; `cancelled` means uncommitted work and cleanup
settled. A client abort alone is not confirmation. Already completed outputs remain
in the Location.

See [upload.md](./upload.md) for session/manifest/chunk request schemas and
[progress.md](./progress.md) for durable offsets and legacy in-memory progress.

# File Transfer API Documentation

The [API Reference](./API_REFERENCE.md) is the authoritative server contract.
The focused guides below describe upload sessions, progress, and upload errors.

## Authentication

Protected routes accept the HttpOnly session cookie or
`Authorization: Bearer <token>`. The current `/auth/login` response sets a
session cookie and returns account information; it does not return a JWT in the
JSON body. Do not copy session credentials into browser local storage. See the
[authentication contract](./API_REFERENCE.md#authentication) for account and
session behavior.

## Resumable Upload Flow

New Browser and Desktop clients use durable upload sessions. They read the
active chunk size, prepare a checksummed manifest, create a session, register
and seal manifest pages, then upload raw chunks with `Content-Range` and
`X-Chunk-SHA256`. The server returns an authoritative `uploadedOffset` for
reconciliation after a lost response. Clients finalize completed files and
then the session; resuming after a restart requires validating the source
against the original manifest. Existing multipart endpoints remain available
for legacy integrations.

See the [Upload API](./upload.md) for request schemas, limits, storage behavior,
and cancellation. See the [Progress API](./progress.md) for transfer states,
byte counters, and retention.

## Reference Pages

- [Complete API Reference](./API_REFERENCE.md) — authentication, Locations,
  file browsing and mutation, transfers, shares, administration, and TLS.
- [Upload API](./upload.md) — reservations, sessions, manifests, chunks,
  multipart compatibility, storage, and cancellation.
- [Progress and Cancellation](./progress.md) — response fields, lifecycle,
  cancellation settlement, polling, and retention.
- [Upload Errors](./error-codes.md) — HTTP statuses and recovery decisions.

# Server Locations

## Configuration Schema

The existing `fileSystem.storagePath` remains the migration and default fallback. Multiple server-side roots are configured as a JSON array in the optional `[locations]` section of `src/config.ini`:

```ini
[fileSystem]
storagePath=./storage

[locations]
definitions=[{"id":"folder-a","displayName":"Folder A","rootPath":"/FolderS/FolderA","enabled":true,"readOnly":false,"order":10},{"id":"folder-b","displayName":"Folder B","rootPath":"/FolderS/FolderB","enabled":true,"readOnly":true,"order":20}]
```

Each Location contains:

- `id`: stable opaque identifier matching `[A-Za-z0-9][A-Za-z0-9_-]*`. It is safe to expose as an API identifier, but it must not encode a filesystem path.
- `displayName`: user-facing name. UI must show this instead of `rootPath`.
- `rootPath`: server-side filesystem/NFS mount root. It is never returned to ordinary clients.
- `enabled`: disabled Locations remain configured and report `disabled` health, but are not selectable.
- `readOnly`: capability metadata used by later API authorization work.
- `order`: explicit display/selection order. Filesystem or NFS creation time is never used.

If `definitions` is omitted, `LocationManager` exposes one `default` Location from `fileSystem.storagePath`. Existing deployments therefore keep their current behavior without migration.

## Runtime Rules

- Location configuration is server-controlled. A request cannot choose or construct a root path.
- Relative paths are resolved under the selected Location root and traversal outside that root is rejected.
- A Location has its own filesystem, cache, and search scope. Shared Redis deployments must prefix keys with `location:<id>`.
- Changing `rootPath` for an existing `id` requires a service restart. The old cache scope is discarded; files are not copied or deleted automatically.
- Disabling a Location prevents new selection. Existing sessions must be revalidated and moved to another enabled Location.
- A missing mount reports `missing`; a permission failure reports `permission_denied`; a mounted file reports `not_directory`.
- Health failures are not represented as an empty directory. Listing and mutation APIs must return an explicit Location/storage error.
- Location initialization may be lazy. Health checks and cache scans should run only when a Location is selected or explicitly inspected.

## Migration

1. Keep the current `storagePath` unchanged and deploy the LocationManager fallback.
2. Add one Location definition whose `rootPath` equals the existing storage path and whose `id` is `default`.
3. Verify the mount, permissions, and cache namespace before enabling additional roots.
4. Add each new NFS root with a new stable `id`; do not rename ids to reflect mount path changes.
5. Keep `storagePath` until all clients and operational tooling use Location ids.

The LocationManager foundation is intentionally separate from the existing file APIs. Location-aware API and UI wiring belongs to issues #120 and #118.

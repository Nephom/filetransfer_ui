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
- `storageType`: `local` (default) or `nfs`. NFS Locations are `offline` when the configured path is no longer a Linux mount point, even if the underlying directory still exists. A legacy global `fileSystem.type=nfs` also marks Locations without an explicit type as NFS; set per-Location `storageType=local` when mixing storage types.
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
- A missing mount reports `offline`; a permission failure reports `permission_denied`; other I/O failures report `error`.
- Health failures are not represented as an empty directory. Listing and mutation APIs must return an explicit Location/storage error.
- Location initialization may be lazy. Health checks and cache scans should run only when a Location is selected or explicitly inspected.

## NFS Mount Lifecycle

The application does not mount or unmount NFS filesystems. Mount lifecycle is an operating-system responsibility and must be prepared by the server administrator before enabling a Location. Use `/etc/fstab`, a systemd mount/automount unit, or an approved manual mount procedure. The application only checks the configured directory, reports `online`/`offline`/`permission_denied`/`error`, and preserves valid cache data during transient failures.

Do not expose a web API that directly runs `mount` or `umount`. Such an API would require a separately designed privileged helper, strict allowlists, credential handling, audit logging, and busy/unmount recovery. After an NFS mount is restored, refresh that Location; other Locations use independent filesystem and cache scopes.

## Operations Runbook

1. Mount the NFS export using the host's approved `/etc/fstab` or systemd configuration.
2. Verify the mount and service-user permissions before enabling the Location.
3. Start or restart the application after mount ordering is ready.
4. Check Location health in the admin view and run a root/subdirectory refresh.
5. If a Location becomes offline, repair the host mount first; do not replace it with an empty directory or delete its cache manually.
6. After recovery, refresh only the affected Location and confirm the other Locations remain available.
7. For rollback, stop the service, restore the application/database backup, restore the previous configuration, verify mounts, and start the service again.

For an existing deployment whose Location definition does not yet include a type, update only the intended Location and keep the automatic backup:

```bash
node scripts/update-location-type.js --location backup --type nfs
```

The command creates a timestamped `config.ini` backup and changes no other Location or deployment value. The same field can be edited through Admin Configuration -> Locations -> Storage type.

The production application must never contain real NFS credentials in this repository. Keep mount credentials and host-specific paths in the server's protected configuration.

## Migration

1. Keep the current `storagePath` unchanged and deploy the LocationManager fallback.
2. Add one Location definition whose `rootPath` equals the existing storage path and whose `id` is `default`.
3. Verify the mount, permissions, and cache namespace before enabling additional roots.
4. Add each new NFS root with a new stable `id`; do not rename ids to reflect mount path changes.
5. Keep `storagePath` until all clients and operational tooling use Location ids.

The LocationManager foundation is intentionally separate from the existing file APIs. Location-aware API and UI wiring belongs to issues #120 and #118.

## Database Upgrade

The Location-aware share-link change adds `share_links.locationId` and a `schema_migrations` table. Existing databases are upgraded automatically during server startup, or explicitly with:

```bash
DATABASE_PATH=/path/to/data/app.db npm run migrate:database
```

If `DATABASE_PATH` is omitted, the script uses the normal `src/data/app.db` path. Relative `DATABASE_PATH` values are resolved from the project root. Take a SQLite backup before a production upgrade. The migration is idempotent and preserves existing share links by assigning them to the legacy `default` Location.

`./build.sh upgrade` creates a consistent SQLite backup under `data/backups/` before fetching or applying the upgrade. Backup names include a UTC timestamp, for example `app.db.20260803T120000Z.sqlite`.

The migration does not alter `users.json`; user Location permissions are stored in each user's `locationPermissions` field and users without that field retain the legacy default-Location behavior.

## User Permissions and Health

Regular users can receive Location capabilities through a reusable Permission Role or, for legacy and exception cases, an individual mapping. The WebUI uses Permission Roles as the primary management workflow. See [WebUI Permission Management](permissions.md) for the complete operator guide.

Individual Location mappings are available through:

```text
GET /api/admin/users/:username/locations
PUT /api/admin/users/:username/locations
```

Example mapping:

```json
{
  "locationPermissions": {
    "folder-a": ["list", "read", "upload"],
    "folder-b": ["list", "read"]
  }
}
```

The backend reloads the effective Role and individual mapping from server-side user data on every request. A stale JWT therefore cannot retain a Location after an administrator revokes it. The token contains no filesystem root path or permission snapshot. If both are present, the Role supplies the base matrix and the user's individual mapping overrides matching Locations.

The Location discovery response exposes only permitted Locations and reports one of `online`, `offline`, `permission_denied`, `error`, or `disabled`. Storage failures return an explicit service error; they are not converted into an empty directory response.

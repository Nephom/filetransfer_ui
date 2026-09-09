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
- Relative paths are checked under the canonical Location root. Traversal outside that root is rejected. The configured root itself may be an administrator-selected symbolic link; no symbolic link below that root is allowed, including internal links, dangling links, and linked parents of new files.
- A Location has its own filesystem, cache, and search scope. Redis keys use `fs:v2:<scope-hash>:<family>:<encoded-relative-path>`. The scope hash binds the Location ID to the canonical root and its device/inode identity.
- Configuration updates must replace the Location manager and drain affected filesystem instances before retiring them. `getRevision(locationId)` returns a synchronous opaque configuration hash for detecting changes. A root that changes physical identity inside an existing runtime fails with `ESTALE`; it is not silently rebound. No files are copied or deleted by configuration refresh.
- Disabling a Location prevents new selection. Existing sessions must be revalidated and moved to another enabled Location.
- A missing mount reports `offline`; a permission failure reports `permission_denied`; other I/O failures report `error`.
- Health failures are not represented as an empty directory. Listing and mutation APIs must return an explicit Location/storage error.
- Location initialization may be lazy. Health checks and cache scans should run only when a Location is selected or explicitly inspected.

## Path And Operation Safety

`LocationManager.resolveCheckedPath(locationId, relativePath, options = {})` is the access resolver. It returns a canonical absolute path after checking the enabled Location, NFS mount state, bound root identity, and each existing path component. `options.allowMissing` defaults to `true`; reads should use `false`. Mutations of a selected root should use `options.protectRoot: true`. The synchronous `resolveRelativePath()` is only a lexical resolver, not authorization for I/O. Public Location responses do not contain roots or internal hashes.

The filesystem exports these CommonJS helpers:

```js
const {
  assertSafePath,      // async (rootPath, targetPath, { allowMissing = true } = {}) -> canonical absolute path
  assertSafeTree,      // async (canonicalTargetPath) -> [{ path, stats }], including the target
  assertTransferPaths // async (canonicalSource, canonicalDestination) -> { source, destination }
} = require('./file-system/path-safety');
const { withOperationLocks } = require('./file-system/operation-locks');
```

`assertSafeTree()` checks the complete selection without following links. Copy, delete, and rename preflight recursive selections before mutation. Archive and flatten callers must also preflight before creating output or sending headers. A linked selection is rejected, not silently truncated. Unsupported special objects in recursive selections are rejected too.

Overlapping Locations are permitted. Copy, move, and rename reject equal paths, hard-link aliases, and ancestor/descendant operands. Copy also checks existing destination trees and nested hard-link merge targets before creating any output. The base implementation protects its own configured root from destructive mutations. The caller must separately protect each authorized Location root, including a source owned by another Location.

`withOperationLocks(paths, async callback, { signal } = {})` acquires canonical path and existing inode locks atomically. Parent and child paths conflict. Disjoint operations can proceed. Lock names conservatively fold case and Unicode normalization, including missing targets; this can serialize case-only distinct names on case-sensitive storage. Queued requests recheck inode identity before dispatch. Nested calls reuse their transaction through AsyncLocalStorage; discovered tree identities remain locked until the enclosing transaction settles. Acquire all top-level operands up front. A contended nested expansion fails with `EDEADLK` instead of waiting in a deadlock. Cancellation while waiting returns `ABORT_ERR`. Once admitted, the callback must stop and settle its streams before it resolves or rejects; the lock helper does not itself abort a running stream.

The server must hold one transaction across cross-Location copy and source deletion:

```js
await withOperationLocks([sourcePath, destinationPath], async () => {
  await destinationFileSystem.copy(sourcePath, destinationPath);
  await sourceFileSystem.delete(sourcePath);
});
```

Both paths must first come from their own authorized Location contexts. Destination primitives accept checked cross-Location and trusted upload-temp sources outside their own root, but still enforce no-follow source trees. Construct each runtime as `new EnhancedMemoryFileSystem(rootPath, { locationId })`. Existing operation method names remain available. In-process mutations reconcile affected initialized cache instances, including overlapping views and a nested Location inside a copied destination. Copy updates destination scopes, not an unchanged source scope. A post-mutation cache failure emits a warning rather than making a committed storage operation appear to fail.

Move uses copy/delete fallback only for `EXDEV`. Failed copy never triggers source deletion. A copy failure can leave partial destination data; a delete failure after a successful copy can leave both copies. Report the actual error rather than claiming an atomic rollback or retrying automatically. Error codes such as `ELOOP`, `EINVAL`, `EACCES`, `EPERM`, `ESTALE`, and `EXDEV` are preserved.

These are process-local coordination guarantees, not a filesystem sandbox against hostile external writers, a second server process, or other NFS clients. External link/root replacement between system calls requires OS-level isolation. A server reconfiguration/shutdown must stop admitting old-context requests and drain outer copy/delete transactions and upload streams before calling filesystem `close()`. Close rejects new filesystem/cache work with `ESHUTDOWN`, waits for admitted work, stops timers, and then disconnects Redis. Reuse a new instance after close.

## Redis Cache Migration

All directory hashes, search entries, directory mtimes, index status, invalidation, and statistics are scoped. Search scans only the entry family and matches user input literally, so `*`, `?`, brackets, and backslashes do not become Redis patterns. Metadata is never treated as a file. Listing hits validate the canonical root, directory path, and directory mtime before returning an immutable metadata snapshot from that instance's checked scan. Search hits and actual file I/O still validate current paths; cached metadata never authorizes access through a link or outside the root.

Initialization cold-rebuilds its own scope. It never loads ambiguous legacy data and never removes unscoped keys, old root scopes, another Location's data, or unrelated keys such as password resets. Clear uses scoped SCAN/deletion, never `FLUSHDB` or `FLUSHALL`. Statistics count only the current scope, not the Redis database.

Hot and memory snapshots expire after at most 3000 ms, measured with a monotonic clock from scan start. The cache constructor accepts a shorter `cacheTtlMs`; values above 3000 ms are capped and zero disables hits. Hits and hot-cache promotion do not extend the deadline. Thus an external in-place file edit can show old metadata only within that bounded interval; changed directory mtimes, explicit refresh, and application invalidation trigger a new checked scan sooner. Invalidation expires in-memory snapshots immediately even when Redis cleanup is queued. Returned snapshots cannot be modified by callers.

The existing server `enterDirectory()` followed by filesystem `list()` reuses the same fresh snapshot instead of scanning twice. Concurrent misses recheck the cache when they reach the scan queue, so one scan can satisfy the group. `cacheMetrics.directoryScans` counts actual scan attempts; `hotCacheHits`, `memoryCacheHits`, and `cacheMisses` record the selected read path. Fixture tests assert both these counts and actual `readdir` calls.

Navigation and storage mutation have different index effects. `leaveDirectory()` evicts the directory view with `preserveIndex: true`; it does not remove search entries or index mtimes. Each successful checked `updateDirectoryCache()` scan, including upload `refreshDirectory()` calls, writes current immediate search entries and directory metadata. It removes missing immediate children and cached subtrees whose directory was deleted or replaced by a file. Descendants of unchanged sibling directories remain indexed. Search still checks retained records against the live no-follow path policy.

Enhanced filesystem mutations call `cache.refreshPaths(paths)` with canonical affected paths in each cache's own root. This expires stale views, removes selected old index scopes, refreshes parent/ancestor directories non-recursively, and indexes existing changed directory subtrees after a complete no-follow preflight. File create/write/rename/move/delete does not perform a full Location tree rebuild. Directory copy/rename indexes the selected destination subtree, including new descendants. Deleted subtrees are removed without scanning unrelated sibling trees. `indexDirectory(path)` is also limited to its selected subtree. Reconciliation uses scoped Redis SCAN with bounded deletion batches; it does not rebuild or modify other Locations. The index-status last-completed summary remains a historical full-index summary, not a live file census.

Clear drains previously admitted cache work and invalidates queued old-generation background jobs before removing the scope. Fresh root polling and the next periodic index may repopulate current data. `refreshCache()` on the enhanced filesystem clears and rebuilds the active scope without closing/reusing a closed Redis client. Periodic full-index refresh still uses a checked whole-root walk; `buildIncrementalIndex()` retains its method name but does not skip subtrees based on stale mtimes. Ordinary navigation, uploads, and mutations no longer depend on that periodic job to restore searchable entries. Fresh cached browsing, including pagination, bypasses the indexing queue after boundary validation. Index status returns a copied current progress/last-completed summary without waiting for the index or reading Redis. Close also drains these independent reads. Expired/missing listings, search, and Redis-backed statistics can still wait behind indexing. Large-tree and scoped Redis pruning latency have not been benchmarked in this change.

Before deploying this migration, stop every old application process: old binaries can still call whole-database cache clear. Do not delete old keys automatically. Review and remove obsolete namespaces separately only with an explicit operational decision and backup. A same-ID root change uses a new root scope; the old scope is preserved, not migrated into the new root.

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

Location-aware API and UI behavior is part of the current server contract. New
clients must select an opaque Location id and must never construct or expose a
server filesystem root path.

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

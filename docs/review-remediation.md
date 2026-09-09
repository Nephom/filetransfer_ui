# Src Review Remediation

## Desktop Mutation Regression Follow-up (2026-09-09)

The user reported broken Move/Rename after the original remediation and approved P70–P74. The earlier completion report does not establish that these operations work in the user's running desktop. A stale revision is a hypothesis, not a confirmed cause. Do not replace a captured root revision with a newer revision to replay a mutation.

| PlanID | ExecutionID | Status | File | Detail description |
|---|---|---|---|---|
| P70 | E01 | Complete | fileapi_ui/src/main.tsx | Move/Delete/Undo and Rename use the context-bound api wrapper. Restore one guarded 401 refresh/retry. Keep the selected root revision ahead of refreshed health data. |
| P70 | E02 | Complete | fileapi_ui/src/main.tsx | Move/Delete/Undo retain HTTP status and backend reasons. Unconfirmed results remain unconfirmed; no replay on 409 or lost responses. |
| P71 | E01 | Complete | fileapi_ui/src/features/remote-browser/remote-browser-contracts.ts | Add remoteMutationError to preserve HTTP, top-level and per-path errors independently of success accounting. |
| P72 | E01 | Complete | fileapi_ui/checks/location.test.js | Production handlers call actual HTTP routes. Real expired JWTs trigger login recovery; disk content/path checks validate Rename/Move/Undo/Delete. |
| P72 | E02 | Complete | fileapi_ui/checks/location.test.js | Verify enabled buttons, headers, 401 recovery, root/session changes during recovery, and 409/429/partial error explanations. |
| P73 | E01 | Complete | fileapi_ui/checks/backend-fixture.cjs | Add fixture-only expired JWT issuance and optional production EnhancedMemoryFileSystem with in-memory Redis transport. Existing native fixture checks pass. |
| P74 | E01 | Complete | docs/review-remediation.md | Record reproduced defects, rollback assessment, and exact verification boundaries below. |
| P74 | E02 | Complete | docs/review-remediation.md | Record RELEASE_DATE verification: already 2026-09-09; no date change required. |

### Follow-up Findings And Rollback Assessment

- Reproduced before the fix: the new direct native mutation wrapper bypassed `api()` and its single authenticated 401 retry. Move/Delete stopped at the initial 401. The regression test failed before the fix and passes afterward.
- Reproduced before the fix: Move discarded the backend reason (`Location changed; refresh before retrying`) and showed only an HTTP/count summary. Delete also discarded response reasons. The rejection-message test failed before the fix and passes afterward.
- The originally suspected session/health revision mismatch is **not established as the user's cause**. Requests now consistently keep the selected revision, rather than silently targeting a newer root. A root/session switch during authentication recovery prevents replay.
- A healthy-session Rename/Move/Undo/Delete sequence passed against actual backend HTTP and real disk files even before the request fix. The user's original Rename failure has not been reproduced in their running desktop; recovery in that environment still needs verification.
- Apply a targeted rollback of the direct-invoke mutation path to the established guarded `api()` wrapper. A whole-worktree rollback would also remove unrelated security/path/transfer fixes and is not justified by the reproduced defects. No Git reset, commit, push, packaging or deployment was performed.

### Follow-up Verification

| PlanID | TaskID | file location | Status | Build Status |
|---|---|---|---|---|
| P70 | E01–E02 | fileapi_ui/src/main.tsx | Complete | TypeScript/Vite build passes; mutation/session checks pass |
| P71 | E01 | fileapi_ui/src/features/remote-browser/remote-browser-contracts.ts | Complete | TypeScript build and error-contract checks pass |
| P72 | E01–E02 | fileapi_ui/checks/location.test.js | Complete | 27 Location tests pass, including actual HTTP/disk sequence |
| P73 | E01 | fileapi_ui/checks/backend-fixture.cjs | Complete | Desktop HTTP fixture and 14 native session tests pass |
| P74 | E01–E02 | docs/review-remediation.md | Complete | Documentation/whitespace checked; RELEASE_DATE already current |

- `node --test fileapi_ui/checks/location.test.js fileapi_ui/checks/auth.test.js fileapi_ui/checks/upload-queue.test.js`: **46 passed, 0 failed** (27 Location, 7 auth, 12 queue).
- `npm run build` in `fileapi_ui`: TypeScript and Vite pass. Desktop entry asset: `index-bQVfwh9V.js`.
- `cargo test --offline --locked --manifest-path fileapi_ui/src-tauri/Cargo.toml native_session_tests:: -- --test-threads=1`: **14 passed**.
- Pi independent review ran twice. Its six initial objections were checked against actual closures, identity tuples, backend schema and tests; the reviewer withdrew all six on follow-up. No material residual reported for this patch.
- Test boundary: production desktop handlers, HTTP auth/routes, enhanced filesystem/cache/locks and real file bytes are exercised. Native invocation, React effects, credentials/database services and Redis transport are replaced in the desktop harness. It does not run a live Tauri GUI or the user's server. The 14 Rust tests are a separate native-session gate, not proof of native GUI mutation dispatch.

## Approval Status

- Prepared on 2026-09-09.
- Implementation status: Complete within the approved scope; approved by user.
- This document covers the 20 findings, two performance improvements, and the approved desktop and LOCAL CSS supplement below.
- All approved modules are integrated. The final verification commands below were run on 2026-09-09 against the completed worktree. Production data, deployment configuration, and real credentials were not modified.
- Each PlanID identifies one file. Each ExecutionID identifies one change or verification action in that file.
- Complete/Completed/Implemented rows record completed work within their stated verification boundaries. Fixture integration is not a live Tauri or production-deployment claim. See the final report and remaining limitations below.
- Other agents' completed work is retained; outdated counts and integration blockers are superseded by final evidence. The user subsequently requested commit and push on 2026-09-09. This authorizes publication of the completed work; the reported desktop Rename symptom remains open pending runtime evidence.

## Scope And Decisions

1. Preserve the existing appearance, roles, Location identifiers, filename collision convention, and ordinary file-operation response fields. Do not redesign the UI or change VERSION.
2. Keep cookie and Bearer authentication. Keep existing upload endpoints for external clients. Reject body-only upload credentials because authentication must finish before file parsing.
3. Make usernames and account IDs immutable through account-update APIs. Validate administrator identity, not only a matching username, so an impersonation token with a regular account ID is not accepted as administrator.
4. Treat the configured Location root as an administrator-selected boundary. Resolve its canonical identity. Do not follow symbolic links below that boundary. Reject recursive selections containing links rather than silently omit files. This intentionally changes symlink-based navigation, including links that remain inside the Location.
5. Permit overlapping Location configurations, but reject operations on the same physical object or unsafe ancestor/descendant operands. Use one process-wide lock scope through copy and source deletion. This does not claim protection against hostile external writers, other server processes, or other NFS clients; strong isolation for those cases requires OS-level controls.
6. Use a new Location-and-root-scoped Redis namespace. Rebuild cache data without reading ambiguous legacy entries. Never use FLUSHDB/FLUSHALL or automatically delete old unscoped keys. Stop old application processes before deployment because their cache-clear code can still clear the database.
7. Enforce the configured per-file upload limit and bounded multipart file/field counts. Do not introduce a smaller aggregate upload limit or silently reduce the supported batch size. Reserve destination files exclusively and clean only files owned by the request. Do not buffer entire uploads in memory.
8. Add an optional owned batch reservation before upload and authenticated cancellation endpoints. Updated browser and desktop clients reserve first, so they know the batch ID even if the upload acceptance response is lost. Existing clients can continue uploading without reservation. Updated clients require the updated backend for confirmed server cancellation.
9. A cancellation request is not proof of cancellation. Stop pending work, interrupt active streams, wait for cleanup, and report the actual terminal state. Keep already committed files. Do not retry an already accepted upload merely because progress polling failed.
10. Progress responses expose allowlisted fields only. Track current account ownership and Location permissions. Record actual file bytes; do not use multipart framing bytes as file size or force counters to the declared total.
11. Password-protected share downloads use POST body credentials. Preserve passwordless GET downloads. Reject password-bearing query strings after the coordinated rollout. Count admitted body transfers atomically; HEAD must not consume a download. Document Range-request counting. Do not automatically revoke links or alter historical logs.
12. Build the existing browser application with esbuild and production React 18.3.1. Do not introduce a React major upgrade, Vite migration, or new UI framework. Generate assets under the already ignored build-assets/browser directory. Build during installation/upgrade; check readiness before startup/restart. Keep compilation out of a running service restart handler.
13. Virtualize both table and grid views. Keep selection and operations based on the full Location/path data model. Preserve drag/drop, keyboard access, current row/card styling, and desktop/narrow viewport behavior.
14. Add browser automation as a development-only test dependency. Browser binaries are for verification machines, not normal server installation. Use disposable fixture roots and databases, never production storage or src/data/app.db.
15. Do not modify ignored runtime files, bypass .gitignore, reset the worktree, rotate real secrets, or perform a production deployment. Commit/push requires an explicit user request in this session. Approval of implementation alone does not request publication.

## Finding Coverage

| Review finding | Implementation plans | Verification plans |
| --- | --- | --- |
| Account identity mass assignment and privilege escalation | P01, P02 | P35, P36 |
| Stored XSS in private consoles | P16, P17 | P44 |
| Unauthenticated staged uploads and cleanup | P02, P11 | P39 |
| Unauthorized settings writes and undefined updatedFields | P04 | P36 |
| Search delete/rename targets the wrong file | P04, P18 | P36, P43, P44 |
| Symlink Location escape | P05, P06, P08, P10, P11, P13, P04 | P37, P39, P41 |
| Redis metadata crosses Locations | P09, P10 | P38 |
| Same-object cross-Location move deletes the sole file | P05, P08, P09, P04 | P37, P36 |
| Descendant copy/move recursion | P05, P08 | P37 |
| Truncated upload reports success | P11, P12 | P39, P40 |
| Concurrent same-name upload overwrite | P07, P11 | P39 |
| Late search response crosses view/Location context | P18 | P43, P44 |
| Concurrent source write lost during cross-Location move | P07, P08, P09, P11, P04 | P37, P39 |
| server.host ignored | P04 | P36 |
| Security middleware runs after handled routes | P03, P04 | P36, P44 |
| Location configuration does not refresh runtime | P04, P09 | P36 |
| Accepted batch cancellation only stops the client | P11, P12, P18, P25, P26, P27 | P39, P40, P44, P45 |
| Progress lacks ownership and leaks internal paths | P02, P04, P12 | P36, P40 |
| Concurrent downloads exceed share cap | P13, P14 | P41 |
| Share password and token enter logs | P13, P14, P15, P24 | P41, P42, P44 |
| Production browser build | P20-P23, P28-P34 | P44 |
| Large-list rendering and repeated derivation | P18-P20 | P43, P44 |

## Execution Order

1. Account identity, settings authorization, safe rendering, and log redaction.
2. Path boundaries, shared locks, filesystem operations, and Redis isolation.
3. Upload accounting, cleanup, ownership, and end-to-end cancellation.
4. Sharing concurrency and password transport.
5. Search identity, stale-response handling, production browser build, and virtualization.
6. Regression tests, browser/native builds, independent Pi review, documentation, and the completion report.

Run the tests for each area before moving to the next area. Do not defer all testing until the end.

## Implementation Tasks

File: `src/backend/auth/user-manager.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P01 | E01 | Complete; unit verified | Replace arbitrary update spreading with an explicit editable-field allowlist. Reject username and ID changes. |
| P01 | E02 | Complete; unit verified | Validate types for supported account updates before mutating the in-memory record or saving it. |
| P01 | E03 | Complete; unit verified | Reject authentication when the stored account identity does not match the lookup identity. Do not repair real account files automatically. |

File: `src/backend/middleware/auth.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P02 | E01 | Complete; integrated | Centralize cookie/Bearer token extraction for upload, progress, and role-gated routes. Export extractAuthToken(req); cookie precedence and Bearer parsing pass isolated and integrated HTTP checks. |
| P02 | E02 | Complete; unit verified | Resolve current account activity and immutable identity; require the administrator identity invariant rather than username alone. Return the live user; Location assertCurrent uses setAccountResolver(resolveCurrentAccount), retaining setUserResolver(username). |
| P02 | E03 | Complete; integrated | Reject impersonation-shaped tokens and inactive/deleted accounts before upload storage or progress access. Preserve supported API authentication. Current-account middleware is wired into upload/progress and passes final HTTP checks. |

File: `src/backend/middleware/security.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P03 | E01 | Complete; integrated | Security wrappers dispatch to the latest initializeSecurity(config) handlers before routes and static responses. Live settings refresh and explicit feature switches pass HTTP checks. |
| P03 | E02 | Complete; build verified | Remove the production runtime-Babel unsafe-eval exception. Production browser readiness and Chromium checks pass; required existing inline style/private-page behavior is preserved. |
| P03 | E03 | Complete; unit verified | Redact request/security-event details before logging. Do not record raw suspicious credential values. Use logger-agent redactLogData/redactUrl exports; omit suspicious values, parameter names, raw User-Agent, and upload filenames. |

File: `src/backend/server.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P04 | E01 | Complete; HTTP verified | Security headers/logging run before routes and static responses. Body-dependent validation runs after parsers. |
| P04 | E02 | Complete; HTTP verified | PUT /api/settings uses requireAdmin, accepts only supported booleans, and no longer references undefined updatedFields. |
| P04 | E03 | Complete; HTTP verified | Successful configuration writes refresh the corresponding Location/security runtime and return accurate needsRestart/restartRequiredFields. Failed settings/config saves roll back without runtime refresh. |
| P04 | E04 | Complete; fixture verified | HTTP/HTTPS listeners receive server.host and reject bind errors without readiness. Tests mock listeners; no production listener is started. |
| P04 | E05 | Complete; HTTP verified | Checked/canonical storage contexts protect downloads, archive manifests, and flatten traversal. Reject linked selections before output; retain measured bytes and empty directories. Download/archive guards handle early response closure and stream errors. |
| P04 | E06 | Complete; HTTP verified | Every Location filesystem receives cache identity; concurrent requests share in-flight initialization and close failed instances. |
| P04 | E07 | Complete; HTTP verified | Copy/move/paste retain shared source/destination locks through copy and source deletion. Preflight rejects roots, aliases, descendants, incompatible targets, and cross-item conflicts. Runtime failures retain truthful per-item results and copied-but-not-moved outcomes without automatic retry. |
| P04 | E08 | Complete; HTTP verified | Delete accepts explicit relative item paths and legacy name/currentPath fields. Preflight validates targets; partial outcomes use exact per-path results and actual deletedCount. |
| P04 | E09 | Complete; HTTP verified | Rename accepts oldPath, derives its actual parent, validates newName as a basename, and retains legacy payloads. |
| P04 | E10 | Complete; HTTP/native verified | UploadAPI owns progress/cancellation routes with current typed owner and Location checks, safe serializers, and actual settlement. |
| P04 | E11 | Complete; HTTP/native verified | Batch reservation, cancellation, runtime dependencies, and cookie/Bearer/Location/revision/batch headers are integrated. Obsolete inline progress handling is removed. |
| P04 | E12 | Complete; fixture verified | Cache clear is Location-scoped. Reconfiguration/shutdown stop new storage work and drain requests, uploads, initializers, and all Location instances. |
| P04 | E13 | Complete; HTTP/build verified | Generated assets are served with immutable bundle caching and no-store HTML. Private shells remain outside the static root. Readiness is checked before listening. |
| P04 | E14 | Complete; fixture verified | require.main guards automatic startup and process-handler installation. Imports export the app without starting services; test dependencies replace persistent singletons before import. |
| P04 | E15 | Complete; source/HTTP verified | Serialize configuration-changing handlers, including settings, admin config, and password changes. Config-backed password writes use configManager rather than independent raw-file replacement. Concurrent settings/config save regressions pass. |
| P04 | E16 | Complete; HTTP verified | Validate malformed file/folder names, currentPath, null delete items, and numeric oldPath before string/path operations. All five previously failing malformed cases return 400 without mutation. |
| P04 | E17 | Complete; HTTP verified | Expose opaque Location revisions and validate optional header/sourceLocationRevision/targetLocationRevision only against their associated Location IDs. Stale source or target returns 409. |
| P04 | E18 | Complete; fixture verified | Restart checks ready assets, drains storage/uploads/caches/database, and waits for the child spawn event before exit. Failure paths are exercised with scoped spawn/PID/timer mocks, not a live restart. |
| P04 | E19 | Complete; HTTP verified | Apply the enabled fileLimiter before file/upload/folder/archive routes. Request 51 is limited and disabling the flag restores access. |
| P04 | E20 | Complete; HTTP verified | Remove private storagePath from public cache statistics while preserving Location-scoped statistics. |

File: `src/backend/file-system/path-safety.js` (new)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P05 | E01 | Complete | Resolve canonical roots and inspect existing components for links, including ancestors of new targets. Preserve useful error codes. Verified by temporary-fixture safety tests. |
| P05 | E02 | Complete | Detect equal physical objects, hard-link aliases, and unsafe ancestor/descendant transfer relationships before mutation. Includes case-insensitive aliases and nested merge targets. |
| P05 | E03 | Complete | Provide checked recursive enumeration for copy, delete, archive, and flatten. Reject linked selections without silently omitting content. Export assertSafeTree for server callers. |

File: `src/backend/location/location-manager.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P06 | E01 | Complete | Add asynchronous resolveCheckedPath for actual access while retaining lexical resolution where no I/O occurs. Tested with real roots. |
| P06 | E02 | Complete | Bind canonical root identity to access and health checks; preserve NFS mount checks. Unexpected root replacement returns ESTALE. |
| P06 | E03 | Complete | Expose synchronous opaque getRevision and scoped getNamespace without adding roots or hashes to public Location responses. |

File: `src/backend/file-system/operation-locks.js` (new)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P07 | E01 | Complete | Add atomic canonical path/inode locks, recheck queued replacement identities, and fold missing case-alias names. Retain nested tree identities through the outer transaction. |
| P07 | E02 | Complete | Detect parent/child conflicts while allowing disjoint work. Barrier tests verify reversed operands and EDEADLK on contended nested expansion. |
| P07 | E03 | Complete | Support waiting cancellation, callback-settlement release, and AsyncLocalStorage reentrancy. Tested cancellation, failure release, and nested waiters. |

File: `src/backend/file-system/base.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P08 | E01 | Complete | Apply checked paths to access and protect configured roots. exists returns false only for ENOENT; permission and I/O errors propagate. |
| P08 | E02 | Complete | Preflight source/destination trees and nested merge aliases before output. Checked external Location and trusted temp sources remain supported. |
| P08 | E03 | Complete | Restrict move fallback to EXDEV. Injected rename/copy/delete failures verify error preservation and source retention after failed copy. |
| P08 | E04 | Complete | Public mutations share process-wide reentrant locks. Copy/delete tree inode locks survive the outer server transaction. |

File: `src/backend/file-system/enhanced-memory.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P09 | E01 | Complete | Accept constructor(storagePath, {locationId}) and pass identity into the scoped cache; replace instance locks with the shared coordinator. |
| P09 | E02 | Complete | Retain outer source/destination locks and reconcile affected parent directories and changed subtrees in each initialized cache, including overlaps. Copy preserves unchanged source scopes. Server wraps copy/delete as in P04. |
| P09 | E03 | Complete | Checked listings never fall back around path-policy errors. Refresh serializes cache work; close drains admitted filesystem/cache jobs and rejects new work. |

File: `src/backend/file-system/memory-cache.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P10 | E01 | Complete | Namespace dir, entry, mtime, meta, and statistics by Location plus canonical root/device/inode identity. Fake Redis tests cover every family. |
| P10 | E02 | Complete | Scope all reads, searches, invalidation, rebuild, clear, and key counts. No FLUSHDB/FLUSHALL or whole-database statistics. |
| P10 | E03 | Complete | Cold-rebuild only the current scope. Tests preserve other Locations, old roots, legacy entries, and password-reset keys. |
| P10 | E04 | Complete | Keep bounded immutable hot/memory hits and checked search/I/O paths. Navigation preserves search records; checked directory scans reconcile immediate entries and removed subtrees. Mutations refresh affected trees without full-scope rebuilds. |
| P10 | E05 | Complete | Serialize scans/Redis work and drain independent validated cache hits/status reads on close. Serve current index progress while indexing; expire invalidated snapshots immediately and retain generation-safe clear/close. |

File: `src/backend/api/upload.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P11 | E01 | Completed | Authenticate before Multer/Busboy and enforce runtime-configured file limits plus bounded multipart metadata. |
| P11 | E02 | Completed | Track every owned staged file and use one idempotent cleanup path for parser, authorization, metadata, storage, and abort failures. |
| P11 | E03 | Completed | Validate all final paths and folder targets through the Location path policy before background dispatch or filesystem mutation. |
| P11 | E04 | Completed | Reserve same-name destinations exclusively under shared locks; retry existing collision naming and never unlink another upload's output. |
| P11 | E05 | Completed | Observe file-stream limit/truncated state and complete multipart parsing before success. Await asynchronous file-handler failures. |
| P11 | E06 | Completed | Replace simulated/declared progress with measured file bytes. Treat post-commit cache refresh failure as a warning, not a reason to re-upload. |
| P11 | E07 | Completed | Add owned, single-use, bounded batch reservations and register all validated pending children before returning acceptance. |
| P11 | E08 | Completed | Stop pending work and abort active streams on cancellation. Recheck authorization before publication and settle cleanup before terminal cancellation. |
| P11 | E09 | Completed | Keep active files out of periodic cleanup, expire abandoned reservations, and remove remaining staged files after outer worker failure. |
| P11 | E10 | Completed | Make handler dependencies injectable and avoid constructor filesystem side effects in tests. Remove credential-bearing debug logs. |
| P11 | E11 | Completed | Accept numeric account IDs including administrator 0 and retain exact typed ID plus username ownership checks. |
| P11 | E12 | Completed | Check X-Location-Revision before multipart reception and reject changed or mixed runtime Location contexts. |
| P11 | E13 | Completed | Expose non-cancelling waitForIdle for intake, accepted workers, cache refresh, and cleanup settlement. |
| P11 | E14 | Completed | Enforce the existing enabled extension denylist on parsed and effective filenames without a separate 100 MiB cap. |
| P11 | E15 | Completed | Keep cache refresh inside shared destination locks and prevent old paths from reaching replacement runtime caches. |
| P11 | E16 | Complete; source checked | Detect a request already aborted before parser listeners attach. Settle parser/owned cleanup instead of waiting forever for an earlier disconnect event. Final upload suite passes. |

File: `src/backend/transfer/index.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P12 | E01 | Completed | Store immutable owner, Location, byte-total knowledge, and lifecycle phase on transfer and batch records. |
| P12 | E02 | Completed | Implement reservation claim/expiry and idempotent cancelling/cancelled transitions with privately held worker controls. |
| P12 | E03 | Completed | Preserve actual counters and compute stable pending/completed/failed/cancelled batch totals, including zero-byte and directory-only cases. |
| P12 | E04 | Completed | Add public serializers that omit absolute paths, credentials, worker controls, and raw internal errors. |
| P12 | E05 | Completed | Prevent late callbacks from overwriting terminal results and retain active batch children until workers settle. |

File: `src/backend/api/share.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P13 | E01 | Complete | Add password-body POST downloads, preserve passwordless GET, and reject query passwords without reflecting them. Verified by isolated HTTP tests. |
| P13 | E02 | Complete | Apply checked Location paths at creation and download, including existing share tokens. Verified against internal, external, dangling, and parent links. |
| P13 | E03 | Complete | Reserve download admission atomically after credential/file checks; exclude HEAD and count each admitted Range request. HTTP races and stream-failure tests pass. |
| P13 | E04 | Complete | Use safe metadata/logging, accurate password-presence information, and no-store/no-referrer response policies. Protected links report POST-only credentials and no passwordless direct-download support. |
| P13 | E05 | Complete; HTTP verified | Validate optional X-Location-Revision during share creation and recheck configuration/permission-manager identity across asynchronous work. Changed roots or stale revisions return 409 rather than creating a share for a replacement root. |

File: `src/backend/auth/share-manager.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P14 | E01 | Complete | Replace unconditional download increments with one conditional SQL update checking active state, expiry, and remaining count. Isolated SQLite race tests pass. |
| P14 | E02 | Complete | Preserve explicit unlimited values and provide a password-presence boolean without exposing hashes. Create/list/info metadata and zero-option tests pass. |
| P14 | E03 | Complete | Remove raw tokens from log messages and permit isolated database/logger injection for tests. Export ShareManager; tests use only an in-memory database and captured sinks. |
| P14 | E04 | Complete; HTTP verified | Run the captured Location-current assertion immediately before share insertion, including after password hashing, so root changes during asynchronous creation are rejected. |

File: `src/backend/utils/logger.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P15 | E01 | Complete | Redact share/handoff-token path segments and all query values before writing request URLs, including encoded or malformed inputs. Export redactUrl. |
| P15 | E02 | Complete | Sanitize structured credential fields and download metadata consistently for file and console sinks without request mutation. Export redactLogData; captured-sink tests pass. |
| P15 | E03 | Complete | Inject isolated file/console sinks and create log directories only on writes. Import-time filesystem-side-effect tests pass. |

File: `src/frontend/private/admin.html`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P16 | E01 | Complete | Render user fields with DOM text/properties; preserve table classes and controls. Actual admin script passes hostile-data Chromium tests. |
| P16 | E02 | Complete | Bind account actions with addEventListener and encode account URL segments. Chromium verifies exact selection/edit/delete targets and cookie-only requests. |
| P16 | E03 | Complete | Render role/Location text and matrix identifiers with DOM properties. Chromium verifies hostile values stay inert and permission values round-trip. |
| P16 | E04 | Complete | Render SAN values as text and bind removal actions without executable interpolation. Chromium verifies exact removal targets and locked auto-detected IPs. |

File: `src/frontend/private/super.html`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P17 | E01 | Complete | Render user fields with DOM text/properties while retaining the Super Panel layout. Actual super script passes hostile-data Chromium tests. |
| P17 | E02 | Complete | Bind account actions safely and encode endpoint segments. Chromium verifies exact targets, cookie-only requests, and locked admin/superuser rows. |
| P17 | E03 | Complete | Render role/Location text and matrix identifiers with DOM properties. Chromium verifies inert values and exact permission round-trips. |

File: `src/frontend/public/components/FileBrowser.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P18 | E01 | Complete | Use explicit module imports/exports for the production build without replacing the existing component. Production bundle passes. |
| P18 | E02 | Complete | Capture Location and complete relative paths for delete/rename; group legacy-compatible delete payloads by real parent and show actual partial results. Chromium duplicate-name and partial-delete checks pass. |
| P18 | E03 | Complete | Share request generations/cancellation between directory and search loads. Guard success, error, loading, and selection against stale context. Unit and Chromium race checks pass. |
| P18 | E04 | Complete | Capture scoped X-Location-Revision plus sourceLocationRevision/targetLocationRevision JSON fields associated with explicit IDs. Invalidate same-ID root changes and stale callbacks; reconcile move results by Location/full path and preserve failed/unconfirmed selection without retry. Final Chromium 14 groups and all 30 server tests pass; malformed-name cases are fixed and no longer excluded. |
| P18 | E05 | Complete | Memoize sorted data and Set/map lookups. Preserve full-data range selection. Unit sorting and Chromium 10,000-item range checks pass. |
| P18 | E06 | Complete | Render both table and grid through the virtual list. Chromium bounds, keyboard focus, resize, full selection, and native drag/drop checks pass. |
| P18 | E07 | Complete | Reserve an upload batch before bytes are sent and retain ID, session, Location, and path in the attempt. Chromium reservation/header/Location checks pass. |
| P18 | E08 | Complete | Request cancellation with a separate control fetch and wait for confirmed settlement. Chromium verifies 202 remains active and terminal cancelled uses actual partial bytes. |
| P18 | E09 | Complete | Separate multipart transport from actual server counters. Chromium lost-response/poll-outage/manual-reconcile checks confirm one upload dispatch. |
| P18 | E10 | Complete | Release attempt timers/listeners and initialize the queue store once. Abort session Location/tree requests. Chromium cookie-only, logout, and session checks pass. |
| P18 | E11 | Complete | Gate managed/new direct URLs and copy controls on hasPassword=false, supportsDirectDownload=true, directDownloadMethod=GET. Keep secure-page links for protected/unknown shares. Seven metadata cases pass real clipboard/GET checks within the final 14 Chromium groups. Final build/check pass; generated share.html matches source. |
| P18 | E12 | Complete; Chromium verified | Invalidate directory/search work at navigation entry, before asynchronous Location metadata refresh, so an older search cannot repopulate the departing view. |

File: `src/frontend/public/components/VirtualFileList.js` (new)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P19 | E01 | Complete | Measure viewport, row/card height, grid columns, and gaps with ResizeObserver. Unit and Chromium checks pass; trailing grid gap corrected after Pi review. |
| P19 | E02 | Complete | Render valid table/grid spacers and logical item positions. Chromium observed 21 rows and 52 cards for 10,000 records. |
| P19 | E03 | Complete | Handle resize, view changes, scroll clamping, and keyboard scrolling. Pin at most two extra rows for focus/native drag. Chromium checks pass. |

File: `src/frontend/public/index.html`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P20 | E01 | Complete | Replace development React, Babel, and source-script tags with a generated production entry reference. Production bundle passes. |
| P20 | E02 | Complete | Add spacer geometry, disable scroll anchoring, and constrain .content flex height for narrow layouts. Chromium confirms original row height/font/colors and bounded desktop/narrow layouts. |

File: `src/frontend/public/app.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P21 | E01 | Complete | Import React/createRoot and active components explicitly. Remove runtime global/fallback loading. Chromium cookie login/logout and production-render checks pass. |

File: `src/frontend/public/components/LoginForm.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P22 | E01 | Complete | Export/import the existing login component for bundling without changing its appearance or credential handling contract. Production bundle passes. |

File: `src/frontend/public/queue/store.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P23 | E01 | Complete | Export the current queue store as a module instead of relying on global script order. Production bundle passes. |

File: `src/frontend/public/share.html`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P24 | E01 | Complete | Send passwords only in POST JSON bodies; retain passwordless GET. Chromium verifies no password-bearing URL or Referer header. |
| P24 | E02 | Complete | Gate downloads on valid metadata and guard in-flight submissions, including Enter. Chromium verifies one request for repeated submissions and actual blob completion. |
| P24 | E03 | Complete | Add no-referrer metadata/fetch policy, clear password input, and release blob URLs after download or pagehide. Chromium checks cleanup; styles remain unchanged. |

File: `fileapi_ui/src/features/queue/queue-contracts.ts`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P25 | E01 | Complete | Add non-secret server batch/attempt identity and cancellation-request metadata without persisting credentials or runtime handles. TypeScript and desktop queue checks pass; native handles remain in a private runtime map. |
| P25 | E02 | Complete | Preserve an accepted but unconfirmed upload for reconciliation rather than treating it as safe to re-upload. Lost-response and manual-reconciliation checks pass. |

File: `fileapi_ui/src/features/queue/useTransferQueueActions.tsx`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P26 | E01 | Complete | Reserve batches and capture the upload server/session/Location before native dispatch. Production-hook checks verify reservation order and captured native session, owner, origin, Location, and revision. |
| P26 | E02 | Complete | Send server cancellation after acceptance and distinguish request, confirmation, failure, and completion-won races. Checks also cover cancellation during reservation. |
| P26 | E03 | Complete | Use actual server progress phases/counters and reconcile polling failures without duplicate uploads. Zero-byte, partial-failure, lost-acceptance, and failed-poll checks pass. |
| P26 | E04 | Complete | Clean up attempt timers/listeners, reject stale callbacks, and leave unrelated SFTP/download cancellation behavior intact. Desktop checks pass with explicit fake native commands. |

File: `fileapi_ui/src-tauri/src/main.rs`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P27 | E01 | Complete | Upload transferId identifies one attempt. Preserve pre-dispatch cancellation, wake source and response waits, and remove active registration on drop. Offline locked cargo check passed. |
| P27 | E02 | Complete | Preserve a fully received response when late cancellation is also ready. Emit measured source-read bytes, including zero, without claiming server completion. Leave shared download cancellation defaults unchanged. Offline locked cargo check passed. |
| P27 | E03 | Complete | Add opaque native sessions with isolated cookies, fixed HTTP(S) origin and TLS policy, cached clients, and idempotent removal. Reject stale handles, mismatched origins/TLS options, and cross-origin redirects. Active clients retain the old jar. Offline locked cargo check passed. |
| P27 | E04 | Complete | Add optional sessionId to api_request, api_upload_paths, download_to_disk, download_to_disk_at, download_to_drag_staging, and download_to_drag_staging_at. Omitted handles preserve generic defaults. Proxmox/SFTP unchanged. Offline locked cargo check and desktop build pass. |
| P27 | E05 | Complete | Final native_session_tests run passes 14 tests on macOS with offline locked cargo test: 13 isolated cases plus E06 actual backend integration. Isolated cases use in-memory sources/synthetic responses; E06 uses a test-owned localhost listener. No keychain, production data, or Windows runtime claim. |
| P27 | E06 | Complete; native/backend verified | Production api_request, session client, UploadProgressReader, real multipart and response parsing run against actual Node server routes/UploadAPI through P69. Numeric owners 0/7, wrong-owner 404, stale revision 409, queued cancellation with zero storage/staging files/bytes, exact success counters/download bytes, logout 401 with other session intact, and handle clearing while backend is offline pass. No live Tauri/AppHandle or api_upload_paths command-dispatch claim. |

File: `package.json`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P28 | E01 | Complete | Add esbuild and production React/ReactDOM 18.3.1 as build-time dev dependencies, with browser build/readiness commands. Production bundle passes. |
| P28 | E02 | Complete | Declare busboy directly and add development-only Playwright. Lock diff contains no unrelated dependency upgrades. |
| P28 | E03 | Complete | Add explicit regression/browser test commands. Browser binaries install only on verification machines; startup does not compile or download. Unit and Chromium commands pass. |

File: `package-lock.json`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P29 | E01 | Complete | Lock diff contains only approved additions. Isolated npm ci with scripts disabled passes; React 18.3.1, esbuild and Busboy resolve and lockfile remains byte-identical. |

File: `scripts/build-browser.js` (new)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P30 | E01 | Complete | Bundle only the active browser graph with production React, compiled JSX, minification, and retained license notices. Production bundle passes. |
| P30 | E02 | Complete | Generate hashed assets, index references, share page, favicon, and a manifest under ignored build-assets/browser. Keep private shells and inactive source files out of public output. Production bundle passes. |
| P30 | E03 | Complete | Validate hashes/completeness before replacement with rollback on rename failure. Export publicDirectory/checkBrowserBuild without CLI effects. Unit missing/tampered/import checks pass. |

File: `build.sh`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P31 | E01 | Complete | Add ./build.sh browser without changing the desktop build command. Shell syntax and production build pass. |
| P31 | E02 | Complete | Include dev build dependencies and build/check browser assets in server install and upgrade. Shell syntax passes; Linux package installation is not run on macOS. |
| P31 | E03 | Complete | Build/check assets in the existing isolated upstream dependency/test preflight before fast-forward activation. Shell syntax passes; no deployment run. |

File: `scripts/runtime.sh`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P32 | E01 | Complete | Add shared read-only browser artifact readiness check. Shell syntax and missing/tampered build checks pass; no secrets logged. |

File: `start.sh`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P33 | E01 | Complete | Check browser readiness before service launch and return the build command when invalid. Syntax and readiness checks pass; no service launched. |

File: `restart.sh`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P34 | E01 | Complete | Check replacement browser build before any PID discovery or stop signal. Unit ordering and shell syntax checks pass; no service restarted. |

## Verification Tasks

Test fixtures may use disposable directories under the approved temporary workspace and isolated SQLite databases. Tests must never load production accounts, configuration, logs, storage, or src/data/app.db. Redis tests use a fake/in-memory adapter; network integration uses only test-owned local listeners. Test helpers stay within the listed test files unless a concrete reuse need is found.

File: `src/backend/auth/user-manager.test.js` (new)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P35 | E01 | Complete; tests pass | Test update allowlists/types and immutable username/ID behavior using isolated account data. Include null/empty roleId clearing, editable fields, unchanged input, and zero writes on rejection. |
| P35 | E02 | Complete; integrated checks pass | Original escalation chain is blocked by immutable identity and live role checks. Isolated account/middleware tests and P36 actual HTTP administrator/staff/user gates pass. |
| P35 | E03 | Complete; 19 focused tests pass | Test administrator identity checks, cookie/Bearer support, account deactivation, and impersonation-shaped tokens. Auth, session-cookie, and Location tests pass; six changed JavaScript files pass node --check. Tests stub config, account I/O, and logger sinks. |

File: `src/backend/server.test.js` (new)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P36 | E01 | Complete; isolated HTTP checks pass | Numeric admin/user/staff gates, invalid boolean atomicity, live security refresh, concurrent settings/config save serialization in both orders, failed-save rollback without runtime refresh, and the real 50-request file limiter pass. Rate-limit state and flags reset after the test. |
| P36 | E02 | Complete; isolated HTTP checks pass | Import/startup guard, HTTP/HTTPS host forwarding and bind errors, live Location refresh, source/target revision pairs and stale-revision rejection pass. Real restart route rejects a missing build and waits for uploads, all fixture instances, database close, and the child spawn event; spawn/error/exit/PID/timer effects are scoped mocks, not real service restarts. |
| P36 | E03 | Complete; all malformed cases pass | Real duplicate-name search/full-path and legacy rename/delete, invalid basename rejection, and truthful partial I/O failure pass. Numeric fileName, object currentPath, null delete items, numeric folderName, and numeric oldPath now return 400 without mutation. All 30 server tests pass in the full unfiltered 261-test run. |
| P36 | E04 | Complete; isolated HTTP checks pass | Real base filesystem/shared locks verify same-object cross-Location move/cut protection, subtree rejection, archive/flatten/download access, nested symlink rejection, cache scope and private storagePath removal, concurrent initialization, and close/drain ordering. Recording cache and database mocks replace external services. |
| P36 | E05 | Complete; isolated HTTP checks pass | Real JWT/cookies, multipart uploads for numeric owners 0/7, progress bytes, ownership/revocation/cancellation and safe responses pass. Complete private shells load without runtime/config initialization; generated public assets pass byte-for-byte serving and private-path exclusion checks. Temporary fixtures use os.tmpdir()/opencode; no production credentials or data are loaded. |

File: `src/backend/file-system/safety.test.js` (new)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P37 | E01 | Complete | Real temporary fixtures test internal/external/dangling links and linked missing parents; outside sentinel remains unchanged. |
| P37 | E02 | Complete | Test descendants, same objects, overlapping roots, nested hard-link aliases, protected roots, canonical root changes, and case aliases. |
| P37 | E03 | Complete | Inject EACCES, EXDEV, ENOSPC, and delete failures; verify fallback rules, preserved codes, and retained source data. |
| P37 | E04 | Complete | Barrier tests cover cross-instance copy/delete, parent/child and inode locks, cancellation, nested retention/expansion, queued inode replacement, missing case aliases, disjoint work, and close draining. |

File: `src/backend/file-system/memory-cache.test.js` (new)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P38 | E01 | Complete | Fake Redis tests cover every key family, same relative names, same-root different Locations, scoped statistics, and literal wildcard searches. |
| P38 | E02 | Complete | Scoped clear/rebuild/invalidation preserve other Locations, old roots, legacy entries, and password-reset keys. FLUSHDB/FLUSHALL/dbSize fail the fixture. |
| P38 | E03 | Complete | Test root/link guards, bounded TTL, scan counts, paused-index reads, and draining. Integration fixtures verify navigation retains search, upload refresh publishes entries, file/tree mutations reconcile scopes, deleted subtrees vanish, and sibling/other Location records survive. |

File: `src/backend/api/upload.test.js` (new)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P39 | E01 | Completed | Test authentication before parser/storage and cleanup for every rejected multipart/permission/metadata path. |
| P39 | E02 | Completed | Use real parsers to test size boundaries, truncated/malformed multipart, zero-byte files, metadata order, and measured counters. |
| P39 | E03 | Completed | Race same-name uploads with controlled barriers and assert output integrity, exclusive ownership, and safe cleanup. |
| P39 | E04 | Completed | Test reservations, lost acceptance responses, active/pending cancellation, revocation, partial completion, and no duplicate accepted upload retry. |
| P39 | E05 | Completed | Exercise real JWT and current-account middleware with isolated numeric admin and regular accounts, including typed owner mismatch rejection. |
| P39 | E06 | Completed | Test stale revision rejection before parsing on every upload route and manager swaps during checked resolution. |
| P39 | E07 | Completed | Test waitForIdle across receiving, malformed intake, publication, cache refresh, and cleanup without cancellation. |
| P39 | E08 | Completed | Test root replacement, cache resolver replacement, and the parent shared-root lock barrier during active work. |
| P39 | E09 | Completed | Test every blocked extension, filename override bypasses, runtime flag changes, and a real allowed stream above 100 MiB. |

File: `src/backend/transfer/index.test.js` (new)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P40 | E01 | Completed | Test actual/unknown/zero-byte totals and complete pending-child batch accounting. |
| P40 | E02 | Completed | Test reservation expiry, terminal transition guards, idempotent cancellation, and completion/cancel races. |
| P40 | E03 | Completed | Test safe serializers and retention that does not remove active worker state. |
| P40 | E04 | Completed | Test immutable numeric owner IDs, administrator 0, exact typed reservation claims, and inherited child ownership. |

File: `src/backend/api/share.test.js` (new)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P41 | E01 | Complete | Race admissions and HTTP bodies against isolated in-memory SQLite; the accepted count never exceeds the cap. |
| P41 | E02 | Complete | Verify POST credentials, query rejection, passwordless GET, HEAD, Range, current expiry/revocation/count, and unlimited values. |
| P41 | E03 | Complete | Verify metadata, links, safe errors, and file/stream boundaries. SHARE_BROWSER_TESTS=1 runs actual admin/super/share scripts in Chromium. Included in the final 261-test run with zero skips. |
| P41 | E04 | Complete; HTTP verified | Test old/current/omitted share revision headers, mismatched permission runtime, and root changes during permission checks/password hashing. Stale creation returns 409 without a new share. |

File: `src/backend/utils/logger.test.js` (new)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P42 | E01 | Complete | Capture file/console sinks and verify sentinel passwords, cookies, bearer/basic values, share/handoff tokens, and structured credentials never reach them. |
| P42 | E02 | Complete | Verify encoded/malformed URLs, encoded query delimiters, original-request nonmutation, useful operation context, import-time isolation, and safe sink failures. Four logger tests pass. |

File: `src/frontend/checks/file-browser.test.js` (new)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P43 | E01 | Complete | Unit tests cover grouped full paths, duplicate basenames, stable numeric/directory sorting and nonmutation; Chromium covers full-dataset range selection. |
| P43 | E02 | Complete | Unit generation test covers shared directory/search/action invalidation; Chromium covers Location/clear/refresh/logout races. |
| P43 | E03 | Complete | Unit tests cover table/grid bounds, resize columns, empty/partial rows and scroll clamping; Chromium covers measured layout. |

File: `src/frontend/checks/browser.e2e.mjs` (new)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P44 | E01 | Complete | Chromium loads original private admin/super pages against localhost fixtures. User/role/Location XSS is text; edit requests target exact encoded account. No private files edited by browser agent. |
| P44 | E02 | Complete | Chromium covers search delete/rename, stale Location/refresh/search, POST-only share password, upload cancellation settlement and lost-response reconciliation. |
| P44 | E03 | Complete | Chromium covers table/grid, full range selection, End focus, native drag/drop, and widths 1440/1024/720/390. Original row/card style and real spacer positions are compared to the pinned pre-change baseline. |
| P44 | E04 | Complete | Chromium records pinned pre-change baseline versus production cold-load bytes, mount counts and two-frame rendering/input timings for 10,000 items. Exact results and limitations are in docs/browser_frontend.md. |

File: `fileapi_ui/checks/upload-queue.test.js` (new)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P45 | E01 | Complete | Test the production queue hook with mocked native commands for reservation and post-acceptance cancellation. Desktop tests pass without network, keychain, or production environment access. |
| P45 | E02 | Complete | Test lost responses, cancellation failure, session changes, partial outcomes, and polling failures without full re-upload. Production-hook checks pass. |
| P45 | E03 | Complete; evidence separated | Desktop mocks verify progress and unchanged download/SFTP dispatch. P27 E06/P69 separately verify real native transport with actual backend routes. Together these close the planned integration gate, not live AppHandle/API upload command dispatch. |

## Documentation Tasks

File: `docs/api/API_REFERENCE.md`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P46 | E01 | Complete; source checked | Document integrated cookie login, immutable identity, requireAdmin settings, checked paths, full-path mutations, and malformed-input safeguards against final source and P36 evidence. |
| P46 | E02 | Complete; source checked | Document integrated reservation/cancel routes, typed owner/Location checks, numeric progress and totalSizeKnown, with actual native/backend fixture evidence and its limits. |
| P46 | E03 | Complete; source checked | Documented implemented POST share credentials, passwordless GET, rejected query passwords, metadata flags, and atomic admission/counting. Isolated router evidence is separate from whole-service verification. |
| P46 | E04 | Complete; source checked | Document optional scoped source/target revisions, share creation 409, serialized config/password writes, active file limiter, and guarded import/restart lifecycle. |

File: `docs/api/upload.md`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P47 | E01 | Completed | Document pre-parser authentication, file/metadata limits, owned cleanup, real byte counters, and preserved upload endpoints. |
| P47 | E02 | Completed | Document exclusive filename allocation, batch reservation, cancellation races, and remaining filesystem guarantees. |
| P47 | E03 | Completed | Document numeric identity support and pre-parser Location revision header checks. |
| P47 | E04 | Completed | Document extension filtering without a hidden size cap and exact waitForIdle/shared-lock runtime integration requirements. |

File: `docs/api/progress.md`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P48 | E01 | Completed | Define transport/file/committed bytes, unknown totals, pending children, and public response fields. |
| P48 | E02 | Completed | Document cancellation confirmation, partial completion, owner checks, retention, and safe polling retries. |
| P48 | E03 | Completed | Document exact typed owner matching and revision-header checks on progress and cancellation requests. |

File: `docs/locations.md`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P49 | E01 | Complete | Document no-follow roots/trees, overlap conflicts, exact helper contracts, outer server transactions, EXDEV outcomes, and process-local limits. |
| P49 | E02 | Complete | Document cold scoped migration, bounded metadata TTL, metrics, nonblocking warm reads, navigation-only eviction, targeted mutation/upload index reconciliation, and remaining full-index/scoped-pruning latency limits. |

File: `docs/queue.md`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P50 | E01 | Complete; documentation checked | Documented the approved, integrated browser/desktop client contract: reservation, requested versus confirmed cancellation, accepted-job reconciliation, coordinated rollout, and active-record retention. |
| P50 | E02 | Complete; documentation checked | Replace pending native/backend text with final desktop/HTTP/native results and distinguish fixture transport from live Tauri command dispatch. |

File: `docs/browser_frontend.md` (new)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P51 | E01 | Complete | Document active modules, build/install/start commands, ignored output, private boundaries, and exact synchronous publicDirectory/checkBrowserBuild API. Commands and readiness verified. |
| P51 | E02 | Complete | Document visual/selection/upload contracts, pinned-baseline measurements, verification commands, 14 final Chromium groups, Pi fixes, and platform/integration limitations. |
| P51 | E03 | Complete; documentation checked | Record final app-S4ZBXXT2.js payload/count measurements, supersede excluded malformed-test results, and qualify single-sample timings and independent-review conclusions. |

File: `RELEASE_DATE`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P52 | E01 | Complete; no edit needed | Read RELEASE_DATE during this documentation pass. It contains today's date, 2026-09-09. VERSION is unchanged by this pass. |

## Approved Desktop Supplement

The user approved P53-P59. Desktop checks now pass 94 tests, included within
the final 261-test Node run; the desktop TypeScript/Vite build also passes.
P04/P36 integration is complete. P27 E06 separately adds actual native/backend
fixture coverage to the 13 isolated Rust cases. This documentation pass records
the supplied final results and inspected source; it does not claim to have
rerun them or exercised live Tauri command dispatch.

File: `fileapi_ui/src/main.tsx`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P53 | E01 | Implemented; desktop checked | Create an origin-bound native cookie session at login. Validate successful login data, accept administrator ID 0, and keep a real Bearer token distinct from the cookie marker. |
| P53 | E02 | Implemented; desktop checked | Bind saved credentials to server/account. Invalidate late login or credential-load results when the login target changes. Do not persist native handles or session credentials in UI preferences. |
| P53 | E03 | Implemented; desktop checked | Clear the native session on logout even if the server request fails. Reject late refresh results; after password change, invalidate saved credentials and require login. |
| P53 | E04 | Implemented; desktop checked | Deduplicate session refresh and retry an ordinary expired-session request once. Do not replay auth/password failures as session refreshes. |
| P53 | E05 | Implemented; desktop checked | Rename and delete search results by complete relative path and actual parent. Keep legacy fields. Count authoritative per-path results, not HTTP 207 or summary counters; missing and conflicting results remain unconfirmed. Production delete checks cover partial and ambiguous responses. |
| P53 | E06 | Implemented; desktop checked | Bind API undo and drag context to server, native session, owner, Location, and revision. Capture mutation context before dispatch and send explicit source/target Location IDs. Record move undo only for confirmed per-item results and use the returned target path when present. Preserve unconfirmed undo entries. Production move/undo checks cover partial, lost, ambiguous, and late responses. |
| P53 | E07 | Implemented; desktop checked | Send Location/revision and required content headers in cookie and Bearer flows. Pass the captured native session to API downloads and staging. Production mutation and upload checks retain numeric administrator ID 0 and verify cookie-mode native headers. |
| P53 | E08 | Implemented; desktop checked | Guard directory, search, tree, viewer, and action results against stale session, Location, path, or SSH context. Invalidate related state when the Location root changes. Move/delete completion refreshes are bound to the original view generation; pending delete groups stop after a session/root change. |

File: `fileapi_ui/src/features/remote-browser/useRemoteApiActions.ts`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P54 | E01 | Implemented; desktop checked | Guard Location refresh responses by mounted session identity and request generation. Ignore stale errors and loading results. |
| P54 | E02 | Implemented; desktop checked | Compare Location ID and opaque revision. Notify the composition root when a selected Location disappears or its root changes. |
| P54 | E03 | Implemented; desktop checked | Store the selected Location revision while preserving connected SSH choices and API-only action guards. |

File: `fileapi_ui/src/features/remote-browser/remote-browser-contracts.ts`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P55 | E01 | Implemented; desktop/HTTP checked | Add optional revision to the public Location shape used by main.tsx and the remote hook. P04 exposes/enforces revisions; P36 and native/backend checks pass. |
| P55 | E02 | Implemented; desktop checked | Build Location/revision/JSON headers independently of Bearer authentication. Never send the cookie marker as a token. |
| P55 | E03 | Implemented; desktop checked | Derive actual relative parents and group delete targets without losing full paths or duplicate basenames. Parse mutation results by exact path, reject duplicate/malformed outcomes, and preserve explicit legacy whole-operation success without inferring partial identities from processed names. |

File: `fileapi_ui/src/features/share-links/share-links-contracts.ts`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P56 | E01 | Implemented; desktop checked | Add hasPassword to create-response and managed-link shapes. Do not expose password values or hashes. |

File: `fileapi_ui/src/features/share-links/useShareLinksActions.ts`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P57 | E01 | Implemented; desktop checked | Capture the selected file and original Location when opening the share-password dialog. Reject submission after that context changes. |
| P57 | E02 | Implemented; desktop checked | Use the share page for protected links. Do not offer a bare direct URL when hasPassword is true; keep credentials in the request body. |
| P57 | E03 | Implemented; desktop checked | Guard share creation/list results by current context and list generation. Clear the successful password draft and omit secrets from operation details. |

File: `fileapi_ui/src/queue/progress.ts`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P58 | E01 | Implemented; desktop checked | Preserve known zero-byte totals and reject nonfinite counter inputs. Distinguish unknown progress from completed zero-byte work using item completion. |
| P58 | E02 | Implemented; desktop checked | Display a real zero-second ETA instead of treating zero as missing. |

## Approved LOCAL CSS Supplement

File: `fileapi_ui/src/styles/layout/panes.css`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P59 | E01 | Complete; geometry verified | Contain long LOCAL breadcrumbs within .local-pane-heading and its .pane-breadcrumbs with border-box sizing, shrinkable heading, and a LOCAL-only right gutter. |
| P59 | E02 | Complete; geometry verified | Preserve REMOTE geometry and LOCAL appearance in Auto/Large. Use existing --space-2 and --ui-button-height with --control-height-base fallback; do not change shared tokens. Large means ui-layout-mobile, not phone mode. |
| P59 | E03 | Complete; 24 cases pass | Actual Chromium bounds verify LOCAL widths 194.406/274.406/424.406px at pane widths 220/300/450px, preserved left alignment, 6.4px right gutter, and contained breadcrumb buttons. REMOTE geometry is unchanged. |

P59/P64 pass all 24 production-CSS fixture cases. This is measured browser
geometry, not only selector inspection, and not a claim of full native-window
interaction coverage. The CSS agent's implementation and token document are
retained without edits by this final documentation pass.

## Supplemental File Plans

These rows account for actual worktree files not already listed above. The
proposed names `desktop-auth.test.js`, `location-operations.test.js`, and
`desktop-regressions` are not separate files in the inspected worktree. Their
desktop coverage lives in P60/P61. P45 already owns `upload-queue.test.js`.

File: `fileapi_ui/checks/auth.test.js` (new, present)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P60 | E01 | Implemented; desktop checked | Test cookie login, administrator ID 0, Bearer login, invalid successful responses, and non-secret persistence with mocked native calls. |
| P60 | E02 | Implemented; desktop checked | Test logout/refresh races, failed server logout, credential invalidation, changed login targets, and server/account isolation. Included in the final 94 desktop tests within the 261-test run. |

File: `fileapi_ui/checks/location.test.js` (new, present)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P61 | E01 | Implemented; desktop checked | Test cookie-independent headers, actual-parent delete grouping, zero/unknown totals, root revision refresh, and captured protected shares. |
| P61 | E02 | Implemented; desktop checked | Exercise production desktop handlers for full-path rename/delete, cross-parent undo, auth retry boundaries, and stale search/viewer/tree/API/SSH results. Included in the final 94 desktop tests; separate P64 supplies browser geometry coverage. |

File: `fileapi_ui/checks/test-utils.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P62 | E01 | Implemented; desktop checked | Allow explicit import.meta test data and reject unmocked native modules when loading production TypeScript. |
| P62 | E02 | Implemented; desktop checked | Add isolated hook state/effect cleanup, deferred promises, and native JSON responses for the auth, Location, and queue checks. |

File: `docs/css_tokens.md`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P63 | E01 | Complete; documentation checked | CSS agent's text matches the measured LOCAL heading/breadcrumb scope, --space-2 gutter, border-box width, and --ui-button-height with --control-height-base fallback. P59/P64 pass; this final pass did not edit that document. |

File: `fileapi_ui/checks/local-path-layout.e2e.mjs` (new, verified)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P64 | E01 | Complete; 24 cases pass | Measure production CSS with isolated fixture markup at 1440x900 and 937x588, pane widths 220/300/450, Auto/Large, and short/long names. All 24 combinations pass. |
| P64 | E02 | Complete; geometry verified | Compare original/final REMOTE geometry and LOCAL appearance; verify positive-width contained breadcrumb buttons, ellipsis, left alignment, and 6.4px gutter. Fixture markup is not full-app interaction coverage. |

File: `docs/location_tech.md`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P65 | E01 | Complete; documentation checked | Replaced JWT-only login text with native cookie-session, origin/account credential, logout, and refresh contracts implemented by P53-P55. |
| P65 | E02 | Complete; documentation checked | Documented full-path actions, captured share/view/undo contexts, and upload reservation. Separated Location API behavior from LOCAL, SSH/SFTP, REST API, and Proxmox VNC behavior; retained native/backend integration limits. |
| P65 | E03 | Complete; documentation checked | Record integrated revision/full-path enforcement, final desktop/native counts, and measured LOCAL geometry while retaining live-Tauri/platform limitations. |

File: `docs/review-remediation.md`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P66 | E01 | Complete; maintained | Recorded user approval and appended per-file desktop/CSS/test/documentation plans without overwriting other agents' completed rows. |
| P66 | E02 | Complete; maintained | Reconcile source/test filenames and supersede all stale integration, malformed-input, and CSS verification blockers with final evidence. Retain legitimate platform/fixture limits. |
| P66 | E03 | Complete; maintained | Add P69, completed integration/review follow-up actions, command/count evidence, review disposition, and the ordered final report covering every PlanID. Count execution rows separately from report summaries. |

File: `src/backend/location/permissions.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P67 | E01 | Complete; integrated | setAccountResolver and live immutable-identity checks are wired into the Location runtime. A username-only resolver cannot establish the configured administrator. Final HTTP/native tests cover numeric administrator identity. |

File: `src/backend/location/permissions.test.js`

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P68 | E01 | Implemented; isolated checks reported | Record existing tests for unresolved administrator roles, configured administrator identity, current role/revocation, and changed username/ID. P35 reports the combined auth/session-cookie/Location checks; these are not P36 server tests. |

File: `fileapi_ui/checks/backend-fixture.cjs` (new, verified)

| PlanID | ExecutionID | Status | Detail description |
| --- | --- | --- | --- |
| P69 | E01 | Complete; native/backend verified | Start actual server routes/UploadAPI on a test-owned localhost listener with numeric fixture accounts 0/7. Replace persistent services before importing server.js; forbid production config/database/keychain/log/service initialization. Use only the Rust-owned empty temporary directory. |
| P69 | E02 | Complete; native/backend verified | Provide publication-lock hold/release and measured storage/staging inspection for cancellation/success assertions. Bound child lifetime; Rust owns kill/wait, session cleanup, and deletion of its exclusive fixture directory. |

## Final Verification

These are the final parent/user-supplied results for 2026-09-09, reconciled with
the source by this documentation-only pass. Earlier partial/excluded runs are
superseded, not added to these totals.

| Command or check | Final result | Boundary |
| --- | --- | --- |
| `SHARE_BROWSER_TESTS=1 npm test` | 261 passed, 0 failed, 0 skipped | Includes 94 desktop checks and all 30 server tests; Node reports grouped tests/helpers, so subset counts must not be added again |
| Desktop TypeScript/Vite build (`npm --prefix fileapi_ui run build`) | Pass | Reported as build:fileapi in the final handoff; the repository script is build in fileapi_ui/package.json |
| `npm run check:browser` | Pass | Final generated browser entry is app-S4ZBXXT2.js; no runtime Babel/development React in production output |
| `npm run test:browser` | 14 Chromium groups passed | Test-owned browser/server fixtures, not a production deployment |
| `node fileapi_ui/checks/local-path-layout.e2e.mjs` | 24 geometry cases passed | Production CSS with fixture markup; Auto/Large and unchanged REMOTE geometry |
| `cargo check --offline --locked` in fileapi_ui/src-tauri | Pass | macOS native check, not a packaged cross-platform runtime test |
| `cargo test --offline --locked native_session_tests` in fileapi_ui/src-tauri | 14 passed | 13 isolated cases plus actual Node backend fixture integration in P27 E06/P69 |

The native fixture uses production api_request, the native cookie-session
client, UploadProgressReader, real multipart construction/response parsing,
and actual server/UploadAPI handlers. Numeric account IDs 0/7 authenticate by
cookie. Wrong-owner progress/cancel returns 404; stale revision returns 409.
Queued cancellation leaves storage and staging at zero files and zero bytes;
those are cleanup measurements, not fabricated zero transferred-byte counters.
Successful upload counters and downloaded content match exact source bytes.
Logout yields 401 for that session while the other session remains usable;
clearing native handles also works with the backend offline.

LOCAL pane widths 220/300/450px produce path-bar widths
194.406/274.406/424.406px, respectively, with preserved left alignment and a
6.4px right gutter in Auto/Large. REMOTE geometry and LOCAL appearance are
unchanged in the 24 measured cases.

Final browser cold HTML/script bytes are 4,142,905 at the pinned baseline and
227,272 in production. Mounted table rows are 10,000 versus 21; grid cards are
10,000 versus 52. These payload/node counts are measured. Timing samples are
single local runs taken while other jobs ran; they are not a robust benchmark
baseline or evidence for a universal speedup. See [browser_frontend.md](./browser_frontend.md).

## Independent Review

Independent reviews ran; all confirmed issues were fixed and affected checks
were rerun. This is the engineering disposition, not a claim that every tool
response said "all clear".

- Parent review found a real configuration-write race and early-disconnect handling defects. Configuration-changing handlers now serialize; parser/download/archive paths handle already closed requests/responses.
- General review found restart lifecycle, search-entry invalidation, share revision, public cache-stat root disclosure, and inactive file-limiter issues. All five were fixed; regression coverage was added and final suites pass.
- Earlier browser review found trailing grid-gap and Location-poll cleanup issues. Their corrections remain covered.
- Further nested-lock and multiple-promise-catch objections were assessed as hypothetical, not confirmed defects: AsyncLocalStorage makes nested shared locks reentrant, and separate catch observers can independently maintain the queue and forward an error. Source reasoning and passing tests support that disposition; tests alone are not proof of every possible schedule.

## Final Report

Every PlanID appears once below. Execution ranges summarize the detailed rows
above; they do not add new tasks. Build Status distinguishes compiled frontend
assets from JavaScript syntax/tests and documentation, which are not builds.
Node/HTTP evidence refers to the final 261-pass run; desktop checks are its
94-test subset. Browser evidence refers to the 14 Chromium groups.

Ledger totals: **69 PlanIDs and 243 ExecutionIDs**, all complete within the
stated scope. There are no remaining implementation blockers in this ledger.
Report summary rows are excluded from execution counts; untested environments
and live-runtime limitations remain listed separately below.

| PlanID | TaskID | file location | Status | Build Status |
| --- | --- | --- | --- | --- |
| P01 | E01-E03 | src/backend/auth/user-manager.js | Complete | JavaScript; Node/HTTP checks pass, no compilation |
| P02 | E01-E03 | src/backend/middleware/auth.js | Complete | JavaScript; Node/HTTP/native fixture checks pass |
| P03 | E01-E03 | src/backend/middleware/security.js | Complete | JavaScript; security/HTTP checks pass |
| P04 | E01-E20 | src/backend/server.js | Complete | JavaScript syntax and all 30 server tests pass; native fixture passes |
| P05 | E01-E03 | src/backend/file-system/path-safety.js | Complete | JavaScript; filesystem/HTTP checks pass |
| P06 | E01-E03 | src/backend/location/location-manager.js | Complete | JavaScript; Location/HTTP/native checks pass |
| P07 | E01-E03 | src/backend/file-system/operation-locks.js | Complete | JavaScript; shared-lock and cancellation checks pass |
| P08 | E01-E04 | src/backend/file-system/base.js | Complete | JavaScript; filesystem/HTTP/native checks pass |
| P09 | E01-E03 | src/backend/file-system/enhanced-memory.js | Complete | JavaScript; cache/mutation checks pass |
| P10 | E01-E05 | src/backend/file-system/memory-cache.js | Complete | JavaScript; fake-Redis/cache checks pass |
| P11 | E01-E16 | src/backend/api/upload.js | Complete | JavaScript; upload/HTTP/native checks pass |
| P12 | E01-E05 | src/backend/transfer/index.js | Complete | JavaScript; progress/cancellation checks pass |
| P13 | E01-E05 | src/backend/api/share.js | Complete | JavaScript; share HTTP/Chromium checks pass |
| P14 | E01-E04 | src/backend/auth/share-manager.js | Complete | JavaScript; isolated SQLite/share checks pass |
| P15 | E01-E03 | src/backend/utils/logger.js | Complete | JavaScript; isolated log-sink checks pass |
| P16 | E01-E04 | src/frontend/private/admin.html | Complete | Source HTML/script, not bundled; Chromium checks pass |
| P17 | E01-E03 | src/frontend/private/super.html | Complete | Source HTML/script, not bundled; Chromium checks pass |
| P18 | E01-E12 | src/frontend/public/components/FileBrowser.js | Complete | Browser production build and Node/Chromium checks pass |
| P19 | E01-E03 | src/frontend/public/components/VirtualFileList.js | Complete | Browser build and measured geometry checks pass |
| P20 | E01-E02 | src/frontend/public/index.html | Complete | Generated HTML/readiness and Chromium checks pass |
| P21 | E01 | src/frontend/public/app.js | Complete | Browser build and login/logout checks pass |
| P22 | E01 | src/frontend/public/components/LoginForm.js | Complete | Browser build and login checks pass |
| P23 | E01 | src/frontend/public/queue/store.js | Complete | Browser build and queue checks pass |
| P24 | E01-E03 | src/frontend/public/share.html | Complete | Copied source HTML/script; readiness/Chromium checks pass |
| P25 | E01-E02 | fileapi_ui/src/features/queue/queue-contracts.ts | Complete | Desktop TypeScript/Vite build and checks pass |
| P26 | E01-E04 | fileapi_ui/src/features/queue/useTransferQueueActions.tsx | Complete | Desktop TypeScript/Vite build and checks pass |
| P27 | E01-E06 | fileapi_ui/src-tauri/src/main.rs | Complete | Offline locked cargo check and 14 native tests pass |
| P28 | E01-E03 | package.json | Complete | Manifest; Node/browser commands and readiness pass |
| P29 | E01 | package-lock.json | Complete | Lockfile; isolated install evidence retained, not compiled |
| P30 | E01-E03 | scripts/build-browser.js | Complete | Build/readiness/failure-preservation checks pass |
| P31 | E01-E03 | build.sh | Complete | Shell syntax/browser checks pass; Linux install not run |
| P32 | E01 | scripts/runtime.sh | Complete | Shell syntax/readiness checks pass |
| P33 | E01 | start.sh | Complete | Readiness/syntax checks pass; no live service launch |
| P34 | E01 | restart.sh | Complete | Readiness/order checks pass; no live restart |
| P35 | E01-E03 | src/backend/auth/user-manager.test.js | Complete | Included in Node/HTTP verification; not compiled |
| P36 | E01-E05 | src/backend/server.test.js | Complete | All 30 pass in full run; no excluded malformed cases |
| P37 | E01-E04 | src/backend/file-system/safety.test.js | Complete | Included in 261-pass Node run |
| P38 | E01-E03 | src/backend/file-system/memory-cache.test.js | Complete | Included in 261-pass Node run |
| P39 | E01-E09 | src/backend/api/upload.test.js | Complete | Included in 261-pass Node run |
| P40 | E01-E04 | src/backend/transfer/index.test.js | Complete | Included in 261-pass Node run |
| P41 | E01-E04 | src/backend/api/share.test.js | Complete | Node/Chromium-enabled checks pass with no skips |
| P42 | E01-E02 | src/backend/utils/logger.test.js | Complete | Included in 261-pass Node run |
| P43 | E01-E03 | src/frontend/checks/file-browser.test.js | Complete | Node checks pass; earlier optional install check retained |
| P44 | E01-E04 | src/frontend/checks/browser.e2e.mjs | Complete | 14 Chromium groups pass |
| P45 | E01-E03 | fileapi_ui/checks/upload-queue.test.js | Complete | Desktop mocks pass; separate P27/P69 native evidence |
| P46 | E01-E04 | docs/api/API_REFERENCE.md | Complete | Documentation/source consistency checked; not built |
| P47 | E01-E04 | docs/api/upload.md | Complete | Owner documentation retained; not built |
| P48 | E01-E03 | docs/api/progress.md | Complete | Owner documentation retained; not built |
| P49 | E01-E02 | docs/locations.md | Complete | Owner documentation retained; not built |
| P50 | E01-E02 | docs/queue.md | Complete | Documentation/source consistency checked; not built |
| P51 | E01-E03 | docs/browser_frontend.md | Complete | Final measurements/review documented; not built |
| P52 | E01 | RELEASE_DATE | Complete; no edit | Already 2026-09-09; VERSION remains 3.4.0 |
| P53 | E01-E08 | fileapi_ui/src/main.tsx | Complete | Desktop build and 94 desktop checks pass |
| P54 | E01-E03 | fileapi_ui/src/features/remote-browser/useRemoteApiActions.ts | Complete | Desktop build/checks pass |
| P55 | E01-E03 | fileapi_ui/src/features/remote-browser/remote-browser-contracts.ts | Complete | Desktop build/checks pass; HTTP revision checks pass |
| P56 | E01 | fileapi_ui/src/features/share-links/share-links-contracts.ts | Complete | Desktop build/checks pass |
| P57 | E01-E03 | fileapi_ui/src/features/share-links/useShareLinksActions.ts | Complete | Desktop build/checks pass |
| P58 | E01-E02 | fileapi_ui/src/queue/progress.ts | Complete | Desktop build/checks pass |
| P59 | E01-E03 | fileapi_ui/src/styles/layout/panes.css | Complete | Desktop build and 24 geometry cases pass |
| P60 | E01-E02 | fileapi_ui/checks/auth.test.js | Complete | Included in 94 desktop/261 total Node checks |
| P61 | E01-E02 | fileapi_ui/checks/location.test.js | Complete | Included in 94 desktop/261 total Node checks |
| P62 | E01-E02 | fileapi_ui/checks/test-utils.js | Complete | Test helper exercised by desktop checks; not compiled |
| P63 | E01 | docs/css_tokens.md | Complete | Source/geometry contract reconciled; not built |
| P64 | E01-E02 | fileapi_ui/checks/local-path-layout.e2e.mjs | Complete | 24 production-CSS Chromium fixture cases pass |
| P65 | E01-E03 | docs/location_tech.md | Complete | Documentation/source consistency checked; not built |
| P66 | E01-E03 | docs/review-remediation.md | Complete; maintained | Final ledger/report consistency checked; not built |
| P67 | E01 | src/backend/location/permissions.js | Complete | JavaScript; Node/HTTP/native checks pass |
| P68 | E01 | src/backend/location/permissions.test.js | Complete | Included in 261-pass Node run |
| P69 | E01-E02 | fileapi_ui/checks/backend-fixture.cjs | Complete | Actual backend fixture exercised by native test; not compiled |

## Remaining Limitations

- No live Tauri/AppHandle session or api_upload_paths command dispatch was exercised by the new native fixture. It tests the production transport/parser core with actual backend handlers and isolated persistent-service replacements.
- Windows, Linux installation/runtime, NFS, and hostile external filesystem writers were not tested. Shared locks coordinate this process, not other processes or NFS clients.
- No Firefox/WebKit run, screenshot pixel diff, or robust timing distribution is claimed. LOCAL checks use production CSS with fixture markup, not a complete native desktop window.
- Restart uses actual route logic with mocked PID/spawn/timer/exit effects. It does not establish that a real replacement service becomes healthy. No production restart or deployment was performed.
- Redis/account/config/database services are isolated or replaced in integration fixtures. No production data, credentials, secrets, or historical logs were changed. Upload records remain in-memory and non-resumable; cancellation does not roll back committed files.
- Documentation changes do not compile application code. VERSION 3.4.0 and RELEASE_DATE 2026-09-09 remain unchanged; ignored generated artifacts are not staged. Publication was subsequently authorized by the user's explicit commit-and-push request above.

## Out Of Scope

- Redesigning the interface, upgrading the React major, or changing VERSION.
- Rewriting unused legacy frontend/cache implementations.
- Distributed filesystem locks or a claim of atomic sandboxing against hostile external filesystem writers.
- A durable/resumable job service or cancellation rollback of already completed files.
- Editing real account data, .env/config.ini, existing share records, historical logs, or external Redis keys.
- Unrelated dependency upgrades, new desktop themes, or changes to REST/SFTP/VNC modes unrelated to upload cancellation.

If implementation exposes another required file or a material behavior change, add its PlanID/ExecutionIDs and seek approval for the scope change before implementing it.

# Browser Frontend

## Active Sources

The browser application uses React and ReactDOM **18.3.1**, compiled by esbuild in production mode. The active entry is `src/frontend/public/app.js`. Its graph includes `components/FileBrowser.js`, `components/VirtualFileList.js`, `components/LoginForm.js`, and `queue/store.js`. Other legacy browser implementations and the development React/Babel files are not bundled or copied to the public build.

`src/frontend/public/index.html` remains the style and HTML template. The build replaces its `__BROWSER_ENTRY__` marker with the hashed bundle URL. `share.html` and `favicon.ico` are copied without rewriting them. Private `admin.html` and `super.html` remain under `src/frontend/private`, outside the generated static root. Their authenticated routes remain the backend's responsibility.

## Build And Startup

```sh
npm ci --include=dev --include=optional
npm run build:browser
npm run check:browser
```

React, ReactDOM, esbuild, and Playwright are development dependencies. The server does not import them to serve a built application. Busboy is a direct runtime dependency. Browser binaries are not part of normal installation. Build-time dependencies must be available when installing/upgrading; a deployment can omit them from its runtime-only installation after building assets.

- `./build.sh browser` builds and validates browser output only. It does not start a server or run a desktop build.
- `./build.sh install` and `./build.sh upgrade` install build-time dependencies, build the browser, and verify readiness. Upgrade also performs this check in its existing upstream preflight before changing the active checkout.
- The existing `./build.sh build` desktop command is retained.
- `start.sh` and `restart.sh` run the shared read-only `check_browser_build` function. Restart checks before PID discovery or any stop signal. Neither compiles assets.
- Output is `build-assets/browser/public`. The whole `build-assets` tree is already ignored. Do not force-add it to Git.
- The build validates a staging directory before replacement and restores the previous directory if activation fails. Failed compilation leaves the old ready build untouched.

### Backend Integration API

```js
const {
  publicDirectory,
  checkBrowserBuild
} = require('../../scripts/build-browser'); // from src/backend/server.js

checkBrowserBuild(); // synchronous; call before listening
// publicDirectory is absolute: <repository>/build-assets/browser/public
// Serve this directory, not src/frontend/public.
```

Importing the module has no CLI, filesystem-write, build-tool, or service-start side effects. `checkBrowserBuild()` returns `{ version: 1, entry, files }` on success. It throws an `Error` containing `Run npm run build:browser` if output is missing, empty, incomplete, tampered, contains unexpected public assets, or has an invalid entry reference. `files` maps each of the four public assets to its SHA-256 digest. The validator's optional directory argument is for isolated fixture checks.

The CLI defaults to building; `--check` performs read-only verification. `buildBrowser()` is also exported for tests/build tooling, but must not be called by a running-service restart handler. The integrated backend serves the absolute public directory and keeps private shells outside it. Hashed bundles use immutable caching and HTML uses no-store so new entry hashes are discovered. The final verified entry is `app-S4ZBXXT2.js`; this is generated output, not a source filename to pin in the template.

`src/backend/server.js` exports the app on import; automatic startup and process-handler installation are guarded by `require.main === module`. Fixture imports replace persistent services before loading the module. The actual restart route validates browser readiness, stops new storage work, drains requests/uploads/initializers/all Location caches, closes the database, and waits for the replacement child's `spawn` event before exit. Tests mock PID/spawn/timer/exit effects; a successful initiation response is not proof of replacement health. No live restart or build during restart is claimed.

## Behavior And Geometry

The original colors, fonts, icons, row/card styling, toolbar, dialogs, and narrow-width rules remain. Only spacer styles, scroll anchoring, and the content pane's minimum flex height were adjusted. `mobile` naming elsewhere in the repository means the Large profile, not an instruction to redesign this browser UI.

- Directory loads and searches share one request generation and AbortController. Navigation invalidates at entry, before asynchronous Location metadata refresh. Clear-search, Location loss/change, session end, and unmount also invalidate stale success/error/loading/selection callbacks.
- Actions capture their original Location/path context. Search delete groups full relative paths by actual parent and includes legacy `name`/`currentPath` fields. Rename sends `oldPath` plus its actual parent and legacy basename fields.
- Scoped requests retain `X-Location-Revision` from the metadata that produced the view. Paste also sends captured `sourceLocationRevision` and `targetLocationRevision` in JSON beside their explicit Location IDs. The header applies only to its associated Location, not both roots. Same-ID revision changes clear stale data, selection, trees and dialogs; Refresh checks Location metadata before refreshing directory data.
- Paste results are authoritative even on mixed HTTP 207 or all-failed HTTP 500 responses. Only exact source-Location/full-path successes leave the file list and selection. Failed/unconfirmed items remain; copied-but-not-moved outcomes are reported separately and never automatically retried.
- Delete notices use returned successful records/counts. Network or legacy error responses without counts explicitly leave remaining outcomes unconfirmed.
- Sorting is memoized by data and sort inputs; selection uses a Set and sorted-index map. Duplicate basenames remain distinct by full path. Shift selection spans the full sorted dataset, not just mounted nodes.
- VirtualFileList measures the scroll container, real rows/cards, grid tracks, and gaps with ResizeObserver. It uses valid table/grid spacers, four overscan rows, and at most two extra logical rows to keep keyboard focus and native drag sources mounted.
- Table rows retain the measured 40px height and grid cards the measured 152px height on the verification machine. Grid column counts still come from the original 165px desktop / 130px narrow CSS minimums.
- Arrow keys, Home/End, Page Up/Down, Space selection, Enter open/download, Shift ranges, native drag/drop, and offscreen selections operate on the full data model. Resizing recalculates columns and scroll geometry.

## Upload Lifecycle

Each queued upload captures its session, Location, headers, target path, and request context. It reserves with `POST /api/upload/batches` and `{ path, clientAttemptId }`, then sends `X-Upload-Batch-ID` with the multipart upload. Cookie requests omit Authorization rather than sending `Bearer null`.

Transport byte counters include multipart framing and are displayed separately from file progress. Server progress uses the numeric `transferredSize`, `totalSize`, `progress`, and `totalSizeKnown` fields, with actual phase/status and success/failed/cancelled/pending counts. Zero-byte and unknown totals are not replaced with fabricated completion counters.

Cancelling aborts the transport but retains a separate live control fetch for `POST /api/progress/batch/:batchId/cancel` and progress polling. HTTP 202 means cancellation is requested, not settled. Only terminal progress marks a queue item cancelled/completed/failed, including already committed files and completion-won races. Control requests have bounded timers that are cleared after settlement.

After dispatch, a lost acceptance or polling response never triggers another upload. Control requests retry; after repeated failure the queue shows an unconfirmed outcome. **Reconcile** checks the same batch ID without sending files again. Cancellation before the reservation response waits for the known ID and sends no file bytes. Session teardown aborts local requests and attempts a best-effort cancellation; a closed tab cannot guarantee server cancellation. Batch retention/expiry and owner authorization are backend responsibilities, and updated clients require the coordinated backend.

## Verification

```sh
npm run build:browser
npm run test:browser:unit
BROWSER_INSTALL_CHECK=1 npm run test:browser:unit
npx playwright install chromium
npm run test:browser
```

Set `PLAYWRIGHT_BROWSERS_PATH` for verification machines that keep binaries outside the default cache. The implementation run used the pre-approved temporary workspace's `browser-binaries` directory. No browser install/download occurs in normal server startup. The optional installation test performs `npm ci --ignore-scripts` in a disposable directory, checks React versions, esbuild and Busboy resolution, and verifies the lockfile remains byte-identical. It does not rebuild backend native modules.

Unit tests cover action identities, sorting, request generations, geometry bounds, missing/tampered readiness, side-effect-free imports without dev dependencies, shell syntax/ordering, failed-build preservation, and a real test-owned process that remains alive when restart assets are missing. Browser E2E uses only a test-owned listener bound to `127.0.0.1`, in-memory records/batches, synthetic credentials, and isolated browser contexts. That browser harness does not import the production server. Separate P36 and P27/P69 tests exercise actual backend handlers with persistent-service replacements; none read production configuration, databases, logs, or storage.

Chromium checks include original admin/super XSS payloads and exact encoded account edit targets; the generated share page's POST password, duplicate-submit guard, cleared input, and absent referrer; full-path delete/rename; late search/refresh/error/session responses; Location revocation; measured table/grid spacers; keyboard/offscreen selection and native drag/drop; desktop/narrow resize; cancellation during reservation, active transport and accepted processing; and lost-response reconciliation without re-upload.

### Recorded Measurements

Recorded 2026-09-09 on macOS arm64, Chromium 153.0.8010.12, 1440x900 viewport, 10,000 synthetic files. The baseline is pre-remediation commit `ac222f0f65cf8b8846645af2fcfdc9f158e8cb97`, loaded from Git into the fixture server; the revised page uses the generated bundle. Both are served with no-store and no compression. The regression command needs this commit locally (a shallow/source-only checkout may need the history supplied separately); `BROWSER_BASELINE_REF` can explicitly select another pre-remediation reference. It is not implicitly changed when HEAD advances.

| Measurement | Baseline | Production |
| --- | ---: | ---: |
| Cold HTML + script encoded bytes | 4,142,905 | 227,272 |
| Initially mounted table rows | 10,000 | 21 |
| Mounted grid cards in exercised end/focus view | 10,000 | 52 |
| Runtime Babel present | Yes | No |
| Table row / grid card height | 40 / 152 px | 40 / 152 px |

At widths 1024, 720, and 390, the grid measured respectively 4, 5, and 2 columns, with card widths 178, 132, and 180px. Both view types stayed bounded. Original row font, foreground/background color, and row/card dimensions were compared programmatically; spacer positions were checked against logical offscreen row heights.

Payload/node counts above correspond to the final artifact `app-S4ZBXXT2.js` and supersede earlier byte counts. API fixture payloads are excluded from asset bytes. Timing measurements were single local samples collected while other jobs ran; they include automation and frame scheduling, not a robust baseline or benchmark distribution. Earlier timing figures are not presented as final reproducible speedups.

The browser task does not establish screenshot pixel parity, Firefox/WebKit behavior, Linux installation, NFS, or production restart/deployment. Final desktop build and actual backend upload/storage verification are supplied by their separate suites below, not inferred from browser mocks. The native fixture still does not exercise live Tauri/AppHandle upload command dispatch.

## Review

Independent Pi/Haiku browser review found a trailing grid-gap error in virtual scroll clamping and uncancelled Location polling. Both were corrected, with regression checks and session-owned AbortControllers. A scoped browser follow-up reported no material client findings; that is not an all-tools/all-platforms clearance. A preliminary diff-only objection treated top-level imports after declarations as invalid JavaScript; the production build was valid, and imports were moved to the top for clarity.

Earlier optional installation verification (`BROWSER_INSTALL_CHECK=1 npm run test:browser:unit`) passed 10 tests with zero failures/skips. This remains isolated install evidence, not another count to add to the final suite. RELEASE_DATE remains 2026-09-09 and VERSION remains 3.4.0. No commit or push was made.

Final verification on 2026-09-09, supplied by the parent/user and reconciled in this documentation-only pass:

- `SHARE_BROWSER_TESTS=1 npm test`: **261 passed, 0 failed, 0 skipped**, including **94 desktop checks** and **all 30 server tests**. Counts include grouped tests/helpers; do not add subset totals again. Malformed-name safeguards are fixed and no cases are excluded from this result.
- `npm --prefix fileapi_ui run build`: desktop TypeScript/Vite pass. `npm run check:browser`: final browser readiness pass.
- `npm run test:browser`: **14 Chromium groups pass**, including seven direct-share metadata cases, partial/failed paste outcomes, search-entry invalidation, same-ID roots, and captured source/target revisions with stale-target rejection.
- `node fileapi_ui/checks/local-path-layout.e2e.mjs`: **24 cases pass**. LOCAL pane widths 220/300/450px produce path-bar widths 194.406/274.406/424.406px, a 6.4px gutter, and preserved left alignment in Auto/Large; REMOTE geometry is unchanged. This is separate production-CSS fixture coverage, not the browser WebUI's layout.
- Offline locked cargo check and **14 native session tests pass**, including actual Node backend integration through `fileapi_ui/checks/backend-fixture.cjs`. Production native transport/parser code verifies cookie owners 0/7, wrong-owner 404, stale revision 409, zero-file/zero-byte storage and staging after queued cancellation, exact successful bytes/download content, logout isolation, and offline native-handle clearing. It does not launch Tauri or call the AppHandle-dependent upload command.

Parent/general independent reviews found configuration-write and early-disconnect defects plus restart, search-entry invalidation, share revision, public stats-root disclosure, and inactive file-limiter issues. All confirmed issues were fixed and regressions pass. Later nested-lock/promise-catch objections were assessed and rejected using AsyncLocalStorage reentrancy and independent catch fanout, supported by source inspection and passing tests. The disposition is not a claim that every review response said "all clear". See the [complete final report](./review-remediation.md#final-report) and its remaining limitations.

| PlanID | TaskID | File Location | Status | Build Status |
| --- | --- | --- | --- | --- |
| P18 | E01-E12 | src/frontend/public/components/FileBrowser.js | Complete | Production build; Node, Chromium and full HTTP revision checks pass |
| P19 | E01-E03 | src/frontend/public/components/VirtualFileList.js | Complete | Production build; geometry and Chromium pass |
| P20 | E01-E02 | src/frontend/public/index.html | Complete | Generated HTML; visual geometry checks pass |
| P21 | E01 | src/frontend/public/app.js | Complete | Production build; login/logout checks pass |
| P22 | E01 | src/frontend/public/components/LoginForm.js | Complete | Production build; login checks pass |
| P23 | E01 | src/frontend/public/queue/store.js | Complete | Production build; queue checks pass |
| P28 | E01-E03 | package.json | Complete | Browser commands pass |
| P29 | E01 | package-lock.json | Complete | Isolated npm ci passes without lock changes |
| P30 | E01-E03 | scripts/build-browser.js | Complete | Build/readiness/failure-preservation tests pass |
| P31 | E01-E03 | build.sh | Complete | Syntax/browser command pass; Linux install not run |
| P32 | E01 | scripts/runtime.sh | Complete | Syntax/readiness checks pass |
| P33 | E01 | start.sh | Complete | Missing-build rejection test passes; no service launched |
| P34 | E01 | restart.sh | Complete | Invalid build preserves test process; no service restart |
| P43 | E01-E03 | src/frontend/checks/file-browser.test.js | Complete | 10 tests pass with installation gate enabled |
| P44 | E01-E04 | src/frontend/checks/browser.e2e.mjs | Complete | 14 Chromium scenario groups pass |
| P51 | E01-E03 | docs/browser_frontend.md | Complete | Final commands, measurements/review and limitations documented; not built |

# Browser Frontend

## Active Sources

The browser application uses React and ReactDOM **18.3.1**, compiled by esbuild in production mode. The active entry is `src/frontend/public/app.js`. Its graph includes `components/FileBrowser.js`, `components/PaneWorkspace.js`, `components/PaneFileWindow.js`, `components/PaneTools.js`, `components/pane-workspace-utils.js`, `components/VirtualFileList.js`, `components/LoginForm.js`, and `queue/store.js`. Other legacy browser implementations and the development React/Babel files are not bundled or copied to the public build.

`src/frontend/public/index.html` remains the style and HTML template. The build replaces its `__BROWSER_ENTRY__` marker with the hashed bundle URL. `share.html` and `favicon.ico` are copied without rewriting them. Private `admin.html` and `super.html` remain under `src/frontend/private`, outside the generated static root. Their authenticated routes remain the backend's responsibility.

## Admin Log Viewer

The Admin Console keeps separate **System log** and **User / IP activity** views. System log retains its existing `server.log` refresh and download controls. User activity reads the admin-only log APIs and groups recorded IPv4 sources under the selected User; anonymous public-share activity is listed separately. IP groups start collapsed and sort by each User's latest matching activity. Expanding a group shows only the timestamp and operation details, newest first, with pagination for older entries.

User activity can be filtered by an inclusive date range and an exact normalized API operation type. Dates use the server-local date prefix in each log record; `FILE RENAME` and `API RENAME` both match `RENAME`. Applying filters updates the IP summaries and every expanded entry page consistently. The viewer reads per-IP log files without merging them into `server.log`; the existing IPv4-only logging policy remains in effect.

## Interface Styles

The account menu exposes two interface styles. **Classical Style** is the default and preserves the original single-directory browser. **Pane Style** uses the same authenticated API surface in an independent Location card, floating-window, and tool-card layout.

Pane windows keep their own Location, path, files, search query, selection, captured Location revision, minimized state, and maximized state. The pane actions use the production file, paste, delete, rename, share, download, folder, and upload endpoints; preview-only data is not used. A pane can use `Details` or `Grid` view. The titlebar provides Minimize, Maximize/Restore, and Close controls. Minimized panes remain in the workspace state and appear as individual Location-style cards in a left-bottom dock that wraps into additional rows when necessary; the dock has no enclosing frame, each card provides a Close control, and hovering its restore card displays `點擊還原`. Restoring a pane keeps its content, query, selection, and position. The `pane-file-view-mode` local-storage value is written when a pane closes, so the last closed pane determines the initial view of the next pane, regardless of Location.

The Pane Style Account Panel keeps its menu mounted while Style settings are expanded or collapsed. Clicks inside the menu are excluded from the outside-click handler, while clicks outside the menu still close it.

Pane Style custom backgrounds are user-owned backend data. `GET /api/user/background`, `PUT /api/user/background`, and `DELETE /api/user/background` authenticate the request and scope the SQLite record to `req.user.id`; the image Blob, MIME type, dimensions, scale, and position are stored in `user_pane_backgrounds`. The browser reloads the same user's background on every device that uses the account. The old browser-local `filetransfer-ui-pane-background` IndexedDB database is deleted by the new client and is not migrated.

### Pane Themes And Background Layout

The **Central background** select offers four themes, stored in `localStorage` as `pane-background-theme`: `default` (Default Gradient), `light` (Clean Light), `silver` (Silver Gray) and `dos` (MS-DOS). Themes are applied as `data-theme` on `.pane-explorer` and are implemented with `--pane-*` CSS variables. Stored ids from earlier releases (`circuit`, `space`, `ocean`, `aurora`, `neon`) or any unknown value are migrated to `default` on load and written back.

The pane tab bar (`.pane-window-switcher`) takes its colours from `--pane-switcher-bg`, `--pane-switcher-hover` and `--pane-switcher-active`, which every theme defines, so it follows the active theme. MS-DOS uses a blue desktop, light-gray boxes with double frames, solid black offset shadows, square corners and a monospace font. Native `window.prompt` / `window.confirm` dialogs (rename, new folder, delete confirmation) are drawn by the browser and cannot be themed.

The background editor has a **Layout** group next to Position and Scale:

| Button | `fit` | Rendering |
|---|---|---|
| (none pressed) | `cover` | Original behaviour: `background-size: cover`. |
| Left | `left` | Original pixel size (`background-size: auto`), position `0% 50%`, zoom reset to 100%. |
| Center | `center` | Original pixel size, position `50% 50%`, zoom reset to 100%. |
| Expand | `stretch` | `background-size: 100% 100%`: the image is stretched over the whole central area. Position arrows are disabled because there is nothing left to move. |

The preset is stored with the background: `PUT /api/user/background` accepts `fit` (`cover`, `left`, `center`, `stretch`; a missing value means `cover`, anything else is rejected with 400) and `GET` returns it. Migration `007-add-pane-background-fit` adds the `fit` column with default `cover`. Editor tooltips are custom (`data-tip`) and float above the mouse pointer, or above the focused button for keyboard users; they flip below the pointer only when there is no room above.

## Build And Startup

```sh
npm ci --include=dev --include=optional
npm run build:browser
npm run check:browser
```

React, ReactDOM, and esbuild are development dependencies. The server does not import them to serve a built application. Busboy is a direct runtime dependency. Build-time dependencies must be available when installing/upgrading; a deployment can omit them from its runtime-only installation after building assets.

- `./build.sh browser` builds and validates browser output only. It does not start a server or run a desktop build.
- `./build.sh install` and `./build.sh upgrade` install build-time dependencies, build the browser, and check readiness. Upgrade operates in the active checkout: when needed, it prepares dependencies for the database backup, then fast-forwards, rebuilds browser assets, and applies migrations.
- The existing `./build.sh build` desktop command is retained.
- `start.sh` and `restart.sh` run the shared read-only `check_browser_build` function. Restart checks before PID discovery or any stop signal. Neither compiles assets.
- Output is `build-assets/browser/public`.
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

Importing the module has no CLI, filesystem-write, build-tool, or service-start side effects. `checkBrowserBuild()` returns `{ version: 1, entry, files }` on success. It throws an `Error` containing `Run npm run build:browser` if output is missing, empty, incomplete, tampered, contains unexpected public assets, or has an invalid entry reference. `files` maps each of the four public assets to its SHA-256 digest. The optional directory argument selects a different asset directory to validate.

The CLI defaults to building; `--check` performs a read-only readiness check. `buildBrowser()` builds the browser assets and must not be called by a running-service restart handler. The integrated backend serves the absolute public directory and keeps private shells outside it. Hashed bundles use immutable caching and HTML uses no-store so new entry hashes are discovered.

`src/backend/server.js` exports the app on import; automatic startup and process-handler installation are guarded by `require.main === module`. The restart route checks browser readiness, stops new storage work, drains requests, uploads, initializers, and Location caches, closes the database, then waits for the replacement process to spawn before exit. The restart response indicates initiation, not replacement health. Restart does not compile browser assets.

## Behavior And Geometry

Classical and Pane styles share the authenticated API surface while keeping their own layouts and interaction state. `mobile` naming elsewhere in the repository means the Large profile, not a phone-specific browser layout.

- Directory loads and searches share one request generation and AbortController. Navigation invalidates at entry, before asynchronous Location metadata refresh. Clear-search, Location loss/change, session end, and unmount also invalidate stale success/error/loading/selection callbacks.
- Actions capture their original Location/path context. Search delete groups full relative paths by actual parent and includes legacy `name`/`currentPath` fields. Rename sends `oldPath` plus its actual parent and legacy basename fields.
- Scoped requests retain `X-Location-Revision` from the metadata that produced the view. Paste also sends captured `sourceLocationRevision` and `targetLocationRevision` in JSON beside their explicit Location IDs. The header applies only to its associated Location, not both roots. Same-ID revision changes clear stale data, selection, trees and dialogs; Refresh checks Location metadata before refreshing directory data.
- Paste results are authoritative even on mixed HTTP 207 or all-failed HTTP 500 responses. Only exact source-Location/full-path successes leave the file list and selection. Failed/unconfirmed items remain; copied-but-not-moved outcomes are reported separately and never automatically retried.
- Delete notices use returned successful records/counts. Network or legacy error responses without counts explicitly leave remaining outcomes unconfirmed.
- Sorting is memoized by data and sort inputs; selection uses a Set and sorted-index map. Duplicate basenames remain distinct by full path. Shift selection spans the full sorted dataset, not just mounted nodes.
- VirtualFileList measures the scroll container, real rows/cards, grid tracks, and gaps with ResizeObserver. It uses valid table/grid spacers, four overscan rows, and at most two extra logical rows to keep keyboard focus and native drag sources mounted.
- Grid column counts use 165px desktop and 130px narrow CSS minimum widths.
- Arrow keys, Home/End, Page Up/Down, Space selection, Enter open/download, Shift ranges, native drag/drop, and offscreen selections operate on the full data model. Resizing recalculates columns and scroll geometry.

## Upload Lifecycle

Each queued API upload captures its server origin, account, Location, revision, and target. It reads the active chunk size, hashes and preflights the selected sources, then creates a durable `POST /api/upload/sessions` manifest, sends bounded manifest pages, and PUTs each raw chunk with `Content-Range` and `X-Chunk-SHA256`. Hashing occurs before the four-hour session lifetime starts. The server stores verified chunk offsets in SQLite. Legacy clients can continue to use multipart endpoints.

Browser XHR upload progress reports actual chunk-body bytes; server `uploadedOffset` is the resume checkpoint. The Queue aggregates confirmed offsets and active chunk bytes separately from file completion. Zero-byte sessions reach 100% only after the server reports completion.

Large uploads are split into child batches of at most 500 files, with a maximum of two active children. A confirmation warning explains the possible increase in resource usage and reduced efficiency. Same-destination files stay in one ordered collision group. Cancelling aborts active chunk transports and separately requests server-session cancellation; completed files are retained and a completion race may win.

After a lost chunk response, the client reads the same session's authoritative offset before continuing. Completed files are skipped. If the page reloads, active server sessions are listed in the Queue; the user must reselect the original files/folder, and the client checks the manifest hashes before resuming. Browser `File` objects and credentials are never persisted. Sessions expire four hours after creation. Session owner, permissions, Location and revision checks are enforced by the backend on each request.

## Related Documentation

- [Transfer Queue](./queue.md) describes client queue states and transfer
  recovery.
- [Upload API](./api/upload.md) and [Progress API](./api/progress.md) define
  the server-side upload protocol and progress contract.
- [CSS Tokens](./css_tokens.md) documents shared frontend variables.

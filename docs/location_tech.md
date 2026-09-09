# Location mode frontend architecture (`fileapi_ui/src/main.tsx`)

This document describes the Location workspace in the Tauri desktop client. The shared custom-property meanings and fallback chain are documented in [`css_tokens.md`](./css_tokens.md); this document lists which CSS files and selector families consume them. It is a code-level companion to [`locations.md`](./locations.md), the server configuration and operations guide, and [`queue.md`](./queue.md), the transfer queue contract.

## Scope and runtime model

`main.tsx` is the desktop application composition root. It owns authentication, workspace/session persistence, mode selection, Location selection, the LOCAL and REMOTE file browsers, transfer orchestration, overlays, settings, and the command bar. REST API and Proxmox VNC workspaces are lazy-loaded children; Location mode remains in `main.tsx` because it shares state with the local filesystem, SSH tabs, queue, sharing, and workspace manager.

```text
App
├─ LoginScreen                         -- API login and saved credential option
└─ DesktopApp
   ├─ AppShell + DesktopTitlebar
   ├─ commandbar                       -- mode/context/actions
   ├─ Location workspace
   │  ├─ LOCAL pane (optional in split mode)
   │  ├─ Folders tree (REMOTE)
   │  └─ REMOTE file pane
   ├─ RestApiWorkspace (lazy)
   ├─ VncWorkspaceController (lazy)
   └─ portals: settings, queue, viewer, help, logs, sessions, shares, editors
```

`App` renders `LoginScreen` until `session.token` is available. A successful login stores the JWT only in React state, while non-secret server preferences are persisted in `nfterm-session`. The password is cleared after login. `DesktopApp` receives the authenticated session and manages the remainder of the UI.

## Session, Location, and mode state

### Session and persistence

The `Session` object contains `host`, `port`, JWT `token`, username, user identity/role/permissions, `locationId`, TLS preference, and the saved-user-information flag. `serverUrl()` creates `https://<host>:<port>` after `validateServer()` rejects protocols, paths, invalid hostnames, and invalid ports.

The login request is a Tauri `api_request` invocation to `POST /auth/login`. `ApiResponse` wraps the native byte response and exposes `text()`, `json()`, and `arrayBuffer()`. `readError()` understands the server's nested `error.message`, `error`, and `message` shapes. `IGNORE SSL` is passed as `ignoreTlsErrors`; it does not change server authorization.

Saved API credentials use the OS credential store through `rest_load_secret`, `rest_save_secret`, and `rest_forget_secret`. `nfterm-session` contains connection preferences but not the password. `fileapi-app-mode`, `nfterm-settings`, and other keys described below are local UI state, not server configuration.

### Location discovery and authorization

`loadLocations()` calls `GET /api/locations`, filters entries without an id, updates the list, and selects the first permitted Location if the current id is no longer available. It runs after login and every 15 seconds. The server response is authoritative: the client never constructs a filesystem root path.

`activeLocation`, `locationOnline`, and `hasCapability(capability)` are the common guards used by the UI. API Remote operations require an online Location and the relevant capability (`read`, `upload`, `mkdir`, `move`, `rename`, `share`, or `delete`). `api()` adds `Authorization: Bearer <JWT>` and `X-Location-ID`; `apiForLocation()` is used for a specific Location, such as health/selection checks. SSH browsing bypasses Location capability checks because it uses a connected SSH profile instead.

Changing Location via `selectLocation()` clears the SSH browse source, resets paths/selections/tree state, records an operation-log entry, updates `session.locationId`, and reloads the remote root and folder tree. A Location health failure is displayed as an error; it is not treated as an empty folder.

### Three application modes

`appMode` is `location | rest | vnc` and is persisted as `fileapi-app-mode`. VNC can only be restored when `desktopSettings.proxmoxVncModeEnabled` is enabled; disabling that setting forces Location mode. The context picker shows Location ids and connected SSH browse targets in Location mode, REST entries in REST mode, and VNC entries in VNC mode.

`splitMode` is persisted as `file-layout-mode`. In split mode the workspace has LOCAL and REMOTE panes and `activePane` determines where New folder, Rename, Delete, View, and Select all apply. `collapseMainPaneEnabled` replaces the main pane resize bars with explicit collapse/restore controls. The setting is intentionally global to Location, REST, and VNC, while LOCAL's internal tree resize remains available.

The Location command bar measures its rendered action buttons with `ResizeObserver`. In the Auto profile's desktop layout, action buttons retain their intrinsic label width during measurement so flex-shrink cannot hide an overflow condition. When the available width would truncate an action label, it keeps Upload visible and moves the remaining file actions, including Refresh, into the accessible `More actions` menu instead of rendering an ellipsis label. The Large profile continues to use the same overflow menu directly through its profile layout.

## File data and navigation

The shared `FileItem` shape is `{ name, path, isDirectory, size, modified }`. Remote API paths are Location-relative; SSH paths use SSH absolute-style paths. LOCAL paths are normally HOME-relative (`""`, `Documents/a.txt`). LOCAL browser mutations are disabled, but readable sources can be inspected and uploaded. Windows read-source validation accepts canonical absolute paths, including UNC shares and paths outside HOME on the HOME drive; actual access remains subject to OS permissions. Root discovery still hides the HOME drive from regular users. Unix/macOS roots are exposed for read-only traversal. Write destinations use separate Rust validation and are not authorized by the read-source policy.

Important helpers:

| Helper | Responsibility |
|---|---|
| `parentPath` | Moves up one API-relative path; unchanged by LOCAL root handling. |
| `isAbsoluteLocalPath`, `localBreadcrumbSegments` in `path-utils.ts` | Recognize LOCAL roots and return the root plus child breadcrumb targets. A UNC `//server/share` is one root, not two folders. |
| `localParentPath`, `showLocalUp` in `path-utils.ts` | Clamp navigation at Unix, drive, and UNC-share roots. An absolute HOME argument is supplied only for elevated navigation above HOME. |
| `sshParentPath`, `joinSshPath` | Normalize SSH navigation. |
| `formatSize`, `fileTimestamp`, `compareFileItems`, `sortFileItems` | Display, timestamp normalization, sorting, and directory-first ordering. |
| `normalizeColumnWidths`, `readPersistedColumnWidths` | Validate persisted Name/Modified/Size percentages before rendering `<col>` elements. |

`loadFiles()` browses either `ssh_list_directory` or `GET /api/files?path=...&sort=...&order=...&directoriesFirst=...`. It resets selection and records start/completion/failure operation logs. `loadTreeChildren()` performs the equivalent directory-only query for the REMOTE folder tree. `loadLocalFiles()` uses `local_list_directory`; `refreshLocalFiles()` reloads the current directory; `loadLocalTreeChildren()` uses `local_list_directories` with a cache and request-generation guard so stale asynchronous responses cannot overwrite a newer navigation.

The LOCAL tree starts with the `HOMEDIR/` node. On Windows, `list_local_roots` adds non-HOME drive roots that the current process can enumerate for regular users; the HOME drive remains represented only by `HOMEDIR/` unless the process is elevated. Unix/macOS also expose `/` as a read-only root. `local_home_path` remains available for HOME-relative breadcrumb handling. Local tree expansion is lazy; remote and local folder nodes expand after a 650 ms drag hover, and drop targets auto-scroll when the pointer approaches a scroll boundary.

Windows roots use the same canonical/display path as directory listings and are deduplicated. If a mapped drive resolves to UNC, the tree displays that UNC identity instead of a separate drive-letter alias. Both `//server/share` and its trailing-slash form navigate as the same root; neither Up nor breadcrumbs manufacture a server-only or local-drive parent. This does not discover additional network shares or mount SMB shares on Unix.

## Transfer and file actions

All long-running transfers are represented by the shared queue (`TransferQueueItem`) and executed through `QueueScheduler.runExclusive`. Queue persistence uses `nfterm-transfer-queue`; active queued/running items restored after application exit become `needs_user_action`, because credentials or the original request may no longer be safely available. Sensitive download headers/body/URL are removed from the persisted representation.

| Function | Behaviour |
|---|---|
| `upload`, `uploadPaths` | Pick local files, inspect them, confirm, then enqueue API or SSH upload. |
| `download`, `enqueueDownload`, `enqueueQueueDownload` | Queue one file, archive download, or selected file set to LOCAL. |
| `executeQueuedUpload` / `executeQueuedSshUpload` | Stream API upload or invoke SFTP upload; verify the source snapshot and handle progress. |
| `executeQueuedDownload` / `executeQueuedDownloadSet` / `executeQueuedSshDownload` | Stream native/API, multi-file, archive, or SFTP downloads. |
| `runQueued*` | Serialize each item and dispatch through the scheduler. |
| `retryQueueItem` | Re-authenticates SSH when required and applies queue recovery policy. |
| `downloadRemoteItemsToLocal` / `uploadLocalItemsToRemote` | Implement split-pane drag/drop using the same queue path as toolbar actions. |

API uploads use `inspect_upload_paths` followed by native `api_upload_paths` to `POST /api/upload/multiple`, with `X-Location-ID`, source fingerprint verification, progress events, and retry classification. API downloads use `download_to_disk`/`download_to_disk_at`; SSH uses `ssh_upload_path`, `ssh_download_path`, and related staging commands. Single files and folders have different queue kinds (`download` versus `download-set`), and guest/remote archive behaviour is kept out of the UI thread.

LOCAL browser mutations remain disabled: new folder, rename, delete, LOCAL-to-LOCAL move, compression, extraction, and LOCAL undo. A readable LOCAL file or directory may still be uploaded to REMOTE, subject to API capabilities or the SSH account's permissions. `ssh_upload_path`, `scp_upload`, and `proxmox_agent_upload_file` validate their existing source through `resolve_local_read_entry`, as API upload inspection already does. File/directory and Guest Agent size limits still apply. REMOTE-to-LOCAL downloads retain their separate writable destination checks.

External editing is distinct from browser mutations. The LOCAL viewer's Edit action opens the original file in Notepad on Windows without a write-permission precheck or fallback copy. OS/share permissions and the editor determine whether saving succeeds. The built-in viewer's size/encoding limits still apply to reaching that action.

Drag/drop supports:

- LOCAL → API Remote or SSH Remote upload;
- Remote → LOCAL download;
- Remote → Remote move;
- LOCAL → LOCAL move is intentionally not supported because LOCAL is read-only;
- folder-tree drops, file-list drops, auto-expand, and auto-scroll.

Windows external drag-out is deliberately disabled; the stable Download/Queue route is used instead. `ensureApiRemote()` prevents API-only actions from being applied to an SSH browse target.

## Rename, delete, move, undo, and sharing

`moveItems()` chooses SFTP, API Remote, or cross-source copy/verification based on source and destination. `moveLocalItems()` performs LOCAL-only moves. `rename` and `remove` use confirmation settings, capability guards, refresh the affected panes, and write operation logs. `recordUndoableRename()` and `recordUndoableMove()` write reversible metadata when undo history is enabled; undo never bypasses permissions or path validation.

`share()` creates a share for the selected API file through `POST /api/files/share`, including `locationId`, optional expiration, and the configured secure/direct mode. Secure mode may open the password modal and returns a web-page link; direct mode returns a bare download URL for tools that cannot render a share page. `loadShareLinks()` uses `/api/files/shares` for regular users and `/api/admin/share-links` for administrators. The share manager groups Active, Revoked, Expired, and Exhausted links; revoke and history-delete operations call the corresponding DELETE routes.

`downloadPath()` encodes every path segment. Do not replace it with a raw path interpolation: this protects spaces, Unicode, and path delimiters when constructing download URLs.

## SSH integration

SSH profiles live inside managed Workspaces. A connected SSH terminal tab is also a valid Location-mode browse source. `findSshProfileById()` resolves the profile and `connectedSshBrowseOptions()` exposes only profiles with a connected tab. The SSH entry editor and password commands are owned by `main.tsx`; terminal lifecycle/event bridging is delegated to `useTerminalLifecycle` and `useSshEventBridge`.

Switching away from an SSH browse source clears the source id and reloads the API Location. SSH transfers retain the profile id and use SFTP-native operations; they do not send `X-Location-ID`.

### Terminal paste contract

Each tab keeps its xterm instance through dock collapse and tab changes. Instance disposal is separate from cancellation of asynchronous creation. Pending clipboard reads also capture the active paste context, session ID, and connection-boundary token: switching away and back, reconnecting, closing, or collapsing cannot deliver an old clipboard result into a new context.

Keyboard paste, right-click paste, and native paste events share one validation and dispatch path. Accepted text goes through one `terminal.paste()` call and the existing per-session SSH write queue. Spaces, indentation, tabs, blank lines, trailing whitespace, and logical line breaks are preserved. CRLF/CR are normalized to LF before xterm performs its normal terminal newline conversion. No line is sent separately and no Enter or newline is appended. Left-button selection-copy and OSC 52 clipboard-set behavior are unchanged; selection copies rendered terminal text, not original file bytes.

| Input and setting | Behavior |
|---|---|
| Single line without tabs or unsafe controls | Paste without appending Enter; use xterm's bracket framing when the remote application has enabled it. |
| Line breaks or tabs with remote DEC 2004 enabled | Paste as one protected block, preserving formatting. |
| Line breaks or tabs without remote protection, or with `ignoreBracketedPasteMode` | Refuse the entire paste with zero bytes sent. No unsafe Continue or whitespace-flattening fallback. |
| Sanitize bracketed-paste markers checked | Remove actual ESC/CSI bracket delimiters and recognizable visible wrappers at the outside of the text. Keep marker examples inside source code. Validate the result before sending. |
| Sanitize unchecked | Do not clean the text; actual control markers fail validation instead of escaping the protected paste. |
| Other unsafe C0/C1 controls or DEL | Refuse the entire paste with either setting. |

The setting retains the persisted `bracketedPasteControlEnabled` key and default. It does not enable paste support in the remote application. Alt/AltGraph and IME composition events are not intercepted as paste shortcuts.

Real connection start/end boundaries reset DEC 2004 in the live terminal and retained output. This reset is separate from `VT_SESSION_BOUNDARY_GUARD`, which is appended after initial replay and must not erase a valid current-session mode advertisement.

`fileapi_ui/checks/terminal.test.js` runs production hook logic with mocked lifecycle/clipboard services and real xterm parsing/input. It checks Python indentation, newline forms, tabs, blank lines, control-code rejection, marker cleaning, one-block dispatch, keyboard variants, copy/OSC 52 behavior, collapse, tab changes, and connection races. This proves local payload handling, not arbitrary remote editor behavior. Remote applications can apply auto-indent or interpret input differently; verify actual shell/editor/Python and tmux combinations before claiming end-to-end formatting or execution safety.

### Save Log destination

Every Save Log picker opens with `{ path: "" }`, independent of the LOCAL pane or a previous destination. Rust resolves this to the process user's HOME; Windows prefers `USERPROFILE` and falls back to `HOME`. A picker result of `null` means cancellation, while `""` is a valid HOME selection. The selected destination still passes the existing write check when saving the recording package. Native picker placement, Windows mappings, ACLs, and original-file Notepad behavior require platform smoke tests in addition to the mocked action and path tests in `fileapi_ui/checks/local-filesystem.test.js`.

## UI components and overlays

`PersistentScrollbar` mirrors a scroll container using `ResizeObserver`, scroll events, and pointer dragging. `CommandBarOverflowMenu` is portaled to `document.body` because the command bar clips overflow; it supports Escape, arrows, Home/End, focus restoration, and viewport-aware positioning. Modal drag sessions are tracked by `ModalDragId`/`ModalOffset`. The topmost-overlay Escape handler closes only the highest active layer and restores focus.

The component regions near the bottom of `DesktopApp` are:

- `renderFolderTree` / local equivalent: lazy folder trees and drag destinations;
- `renderLocalPane`: LOCAL title, privilege badge, refresh/tree/view controls, grid/details list;
- command bar: Upload, Download, overflow actions, sort/view/split controls;
- remote pane: breadcrumb, notices, selection count, grid/table, sortable columns, and drop targets;
- status bar and context menu;
- dialogs: share password, save log, settings, share links, workspace/session manager, SSH, REST, and VNC entry editors.

Settings are normalized by `normalizeDesktopSettings()` before use. Theme variables are computed once by `themeStyle()` and applied both to `document.documentElement` (including portaled surfaces) and `AppShell`. Settings can affect UI scale, theme, VNC availability, collapse controls, bracketed-paste sanitization, undo/log retention, confirmations, and sharing defaults.

## CSS inventory for Location mode

Location mode does not have one feature-local stylesheet. Its styles are assembled by `styles/index.css`, in a deliberate order: tokens/base first, feature/layout modules next, then theme overrides last. The following files are the complete CSS set used by `main.tsx` and the Location shell (component-local files are listed separately):

| File | Location-mode ownership |
|---|---|
| `styles/index.css` | Ordered import contract; keeps base, layout, feature, and final theme layers deterministic. |
| `styles/tokens.css` | Shared colors, spacing, type, control heights, radii, shadows, transitions, and z-index tokens. |
| `styles/desktop-ui.css` | App shell, title bar, navigation, folder/file workspace, generic modals, status bar, terminal dock, and base desktop geometry. |
| `styles/mobile-ui.css` | The `ui-layout-mobile` Large profile: enlarged controls/type and narrow/short viewport stacking. Not a phone-only layout. |
| `styles/mode-switcher.css` | Location/REST/VNC mode switcher, selected buttons, and status dots. |
| `styles/location-control.css` | Location selector, menu, selected/online states, health dot, and chevron. |
| `styles/commandbar.css` | Location action bar, overflow menu, divider, active-pane indicator, and view switch. |
| `styles/context-picker.css` | Context/location/SSH picker popover, groups, selected check mark, and keyboard-friendly options. |
| `styles/account-menu.css` | Account button, role/summary, and account popover. |
| `styles/tls.css` | TLS toggle and shared enabled/semantic toggle treatment. |
| `styles/overlays.css` | Modal covers, floating windows, viewer, queue, overlay stacking and transitions. |
| `styles/settings.css` | Desktop Settings cards, sections, theme preview/revert, confirmation controls, sharing, and history/log controls. |
| `styles/layout/folder-tree.css` | REMOTE and LOCAL tree nodes, expanders, tree loading, and tree drop targets. |
| `styles/layout/context-menu.css` | File-pane right-click context menu and menu action states. |
| `styles/layout/workspace-dialogs.css` | Workspace/session manager, SSH/REST/VNC entry dialogs, share dialogs, and common dialog fields. |
| `styles/layout/file-table.css` | REMOTE table, sortable/resizable columns, rows, selection, file glyphs, and grid/details parity. |
| `styles/layout/terminal.css` | SSH terminal dock and terminal controls embedded in the desktop shell. |
| `styles/layout/queue-settings-dialogs.css` | Queue modal, transfer cards, progress, and queue-related settings surfaces. |
| `styles/layout/panes.css` | LOCAL/REMOTE pane sizing, split mode, folder pane, active pane, and resize handles. |
| `styles/layout/collapse-controls.css` | Location main-pane collapse/restore rail and shared collapse semantics. |
| `styles/layout/buttons.css` | Shared primary/confirm/danger/neutral button semantics. |
| `styles/starship-bridge.css` | Bridge visual profile and base surface/palette compatibility rules. |
| `styles/vnc-interactions.css` | Shared interaction states used by VNC and shell surfaces; harmless in Location mode. |
| `styles/theme/base.css` | Final theme base colors/surfaces. |
| `styles/theme/location-controls.css` | Final theme overrides for Location controls and mode-specific shell controls. |
| `styles/theme/location-panes.css` | Final theme overrides for folder/file/local/remote panes and tables. |
| `styles/theme/dialogs.css` | Final theme overrides for shared dialogs and modal surfaces. |
| `styles/theme/help.css`, `styles/theme/log-view.css` | Final theme overrides for Help and operation-log overlays opened from Location mode. |
| `styles/theme/login.css` | Login-only final overrides; it is part of the global bundle but not the authenticated Location workspace. |
| `styles/theme/rest.css` | Final REST surface overrides; loaded globally for the lazy REST workspace, inactive for Location markup. |
| `styles/theme/vnc.css` | Final VNC surface overrides; loaded globally for the lazy VNC workspace, inactive for Location markup. |
| `ui/dropdown.css` | `Dropdown` trigger/menu used by sort, settings, and shell controls. |
| `ui/mobile-choice-menu.css` | Narrow-layout choice menus and command overflow options. |
| `ui/entry-actions-menu.css` | Compact Edit/Remove menu used by entry managers. |

The lazy/component-local styles are also part of the frontend CSS inventory:
`log-view.css` styles the operation-log overlay, `help/help.css` styles the help
viewer, `rest-api.css` styles REST mode, and `proxmox-vnc.css` styles VNC mode.
`ui/dropdown.css`, `ui/mobile-choice-menu.css`, and
`ui/entry-actions-menu.css` are shared component styles imported by their TSX
components and therefore apply wherever those components are rendered.

`main.tsx` intentionally imports only `styles/index.css`; do not add a second global CSS import there. `styles/theme/README.md` and `styles/layout/README.md` define the ownership rules for adding selectors to those split directories. The lazy/component-local styles are loaded only when their feature is opened, as described above.

## Main Tauri command inventory

| Area | Commands used by Location mode |
|---|---|
| Auth/API | `api_request`, `rest_*_secret` |
| LOCAL | `local_list_directory`, `local_list_directories`, `local_home_path`, `list_local_roots`, `is_local_elevated` |
| Upload/download | `pick_upload_files`, `pick_local_directory`, `inspect_upload_paths`, `api_upload_paths`, `download_to_disk`, `download_to_disk_at` |
| SSH | `ssh_list_directory`, `ssh_upload_path`, `ssh_download_path`, drag-staging commands, SSH secret commands |
| Logs/history | `read_operation_logs`, clear/read/write operation and undo commands |
| UI support | `resolveResource`, clipboard and file-picker commands |

The exact payloads and server routes belong in the API reference; this document records the frontend orchestration and security decisions. When changing a command or response shape, update the TypeScript type, the corresponding guard/error path, and the operation-log event together.

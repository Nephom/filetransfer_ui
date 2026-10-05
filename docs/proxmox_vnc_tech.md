# Proxmox VNC frontend architecture (`fileapi_ui`)

This document is the technical reference for the Proxmox VNC workspace in
`fileapi_ui/src/proxmox-vnc.tsx` and `proxmox-vnc.css`, including its shared
CSS token dependencies and the VNC-specific component/state/function
contract. Location and REST API mode are documented separately in
[`location_tech.md`](./location_tech.md) and [`restapi_tech.md`](./restapi_tech.md).
The shared custom-property contract is in [`css_tokens.md`](./css_tokens.md),
and the broader desktop runtime boundaries are in [`desktop.md`](./desktop.md).

## Tech stack

| Layer | Technology | Notes |
|---|---|---|
| UI framework | React 18 + TypeScript | Function components + hooks only, no class components. |
| Build tool | Vite | `npm run dev` / `npm run build` (`tsc --noEmit && vite build`). |
| Desktop shell | Tauri 2 (Rust) | `src-tauri/`; the webview calls Rust `#[tauri::command]`s via `@tauri-apps/api/core`'s `invoke()`. |
| Terminal | xterm.js (`@xterm/xterm` + `addon-fit`) | SSH terminal tabs. |
| VNC | noVNC (`public/noVNC`) | Loaded at runtime via a dynamic `import()` of `noVNC/core/rfb.js` so it never enters Vite's module graph (it's a plain public asset, not an npm package). |
| Styling | Plain CSS with custom properties (design tokens) | No CSS framework/Tailwind; shared variables are defined in [CSS Tokens](./css_tokens.md). One `*.css` file per feature area, imported from `styles/index.css` or lazily alongside its feature's `*.tsx` (e.g. `proxmox-vnc.css` next to `proxmox-vnc.tsx`). |

## Shared CSS tokens

Shared color, spacing, typography, control, profile, theme, and stacking tokens
are documented in [CSS Tokens](./css_tokens.md). VNC styles use those semantic
variables and keep component-specific layout rules in `proxmox-vnc.css`.

The Large profile (`ui-layout-mobile`) no longer exists; the VNC window uses the
same fluid desktop sizing as every other Pane window, and narrow-window behavior
is defined by the relevant media queries.

## Proxmox VNC workspace (`proxmox-vnc.tsx` + `proxmox-vnc.css`)

### Direct VNC toggle

The VNC workspace portals one **Direct VNC** card into the shared top
commandbar. This is a workspace presentation toggle, not a third application
mode and not a second entry list. When active, the Proxmox entry pane and its
resize controls are hidden, the VNC reader fills the available width, and the
Connection Controls panel is replaced with Direct VNC host and port fields.
Credential fields appear only after the server requests them. The noVNC screen element remains mounted so changing the
connection source does not invalidate the RFB DOM target.

The toggle confirms before disconnecting an active Proxmox or Direct VNC RFB
session. It never reconnects the previous source after switching. Direct VNC
uses a local one-time WebSocket relay whose upstream is the configured TCP VNC
endpoint; the relay validates its path and token before opening the remote
socket. Direct VNC intentionally skips Proxmox VM discovery, QEMU Guest Agent
checks, and VNC file-transfer detection.

### Negotiated Direct VNC credentials

Connect validates only the host and integer TCP port (1-65535), then lets noVNC
negotiate authentication without speculative credentials. The
`credentialsrequired.detail.types` event determines the prompt:

| Server request | Supplied credentials |
|---|---|
| `password` | VNC/viewer password only; no username is required or sent. |
| `username`, `password` | Server account username and account password. For macOS Screen Sharing/ARD, use the account short name and its login password, not the separate viewer password. |
| No credential request | No prompt or keyring access is needed. |
| Unsupported/malformed field request | Fail clearly rather than repeatedly sending an incomplete object. |

An account request does not identify the server OS or uniquely identify ARD.
Direct VNC is therefore labeled Remote desktop, with conditional macOS guidance.
The credential dialog uses the existing FloatingWindow layout and is portaled
inside the active VNC fullscreen root when needed. Collapsing Connection
Controls does not hide it. Continue submits the current complete draft once;
Cancel stops the attempt. Saved credentials are never submitted automatically,
and rejected credentials require an explicit reconnect rather than an automatic
retry. The Proxmox branch continues to supply only the relay response's
`connection.password`; it never reads Direct VNC secrets.

The legacy keyring entry `entryId: "direct-vnc", kind: "password"` remains a
viewer-password candidate and is not deleted or promoted to an account secret.
Account passwords use `entryId: "direct-vnc-account:" + JSON.stringify([host.toLowerCase(), port, username.trim()])`
with `kind: "password"`. Late loads are checked against prompt ownership and
draft revision, so they cannot overwrite typing or cross account/endpoint
changes. A successful connection saves the submitted snapshot, not each
keystroke. Forget saved password targets only the current credential key.
Storage errors are notices and do not turn a successful connection into a
network failure. Host, port, and last username remain non-secret local settings.

### Attempt ownership and deadlines

Each invocation of `connect` owns its RFB client, backend connection ID, timer,
phase, and cleanup closure. `connectionCleanupRef` identifies the current
cleanup; `sessionGenerationRef` invalidates replaced attempts. Every RFB event
checks ownership before changing state. A delayed disconnect or timer from an
old attempt cannot clear the new attempt's timeout.

The 15-second handshake timer begins after RFB construction. It stops while
the Direct VNC credential dialog waits for input and restarts for a full
15 seconds when Continue submits credentials. Connected sessions have no
client-side idle timer. A queued timer checks its identity even after
`clearTimeout`, preventing a false timeout during credential wait or after
success. The remote server may still impose its own authentication deadline.

Cancellation during runtime import prevents a later backend start. A backend
start that finishes after cancellation cleans up its own returned ID, using
the captured Direct/Proxmox source. Teardown closes ownership before asking RFB
to disconnect, so the resulting disconnect event cannot replace a security
failure or timeout reason. A server disconnect during handshake is diagnosed
from the attempt's phase, not a captured React loading flag.

### Direct VNC fullscreen cursor

Direct VNC forces noVNC to use its canvas-based cursor fallback because some
macOS Screen Sharing endpoints do not render the browser cursor URI reliably.
The fallback cursor normally lives under `document.body`. When the VNC screen
enters the browser Fullscreen API, that element moves into the fullscreen top
layer, so `public/noVNC/core/util/cursor.js` listens for `fullscreenchange` and
moves the fallback cursor canvas into the active fullscreen element. It moves
the canvas back to `document.body` when fullscreen ends. This keeps the cursor
visible in both normal and fullscreen display modes without changing VNC mouse
input handling.

### Workspace layout

```
.vnc-workspace (flex row)
├── .vnc-entry-pane-shell (resizable, 220–720px wide)
│   └── <VncEntries>                              -- left sidebar, one of:
│       ├── Entries list mode                     -- when no VM file-transfer route detected yet
│       │   (.vnc-entry-pane)                        entries list + Login/Logout (Proxmox web session)
│       └── File browser mode                     -- once detectTransferMode() finds a route
│           (.vnc-entry-pane.vnc-entry-pane-files)    "← Entries" back button, Upload/Download/Refresh
│                                                      toolbar, multi-select file table, transfer queue
├── pane-collapse chevrons OR PaneResizeHandle     -- collapses/resizes the sidebar itself
└── <section className="vnc-reader">               -- right side, ALWAYS mounted (never unmounts VNC)
    ├── .vnc-reader-heading                        -- workspace name, entry name, session status
    └── .vnc-display-split (flex column)
        ├── .vnc-auth-panel(.open|.collapsed)       -- Connection controls: Node/VM pickers and actions
        └── .vnc-screen-shell                       -- persistent noVNC canvas + display controls
```

The VNC reader and noVNC screen remain mounted while the left sidebar switches
between the Proxmox entry list and the VM file browser. This keeps the RFB
canvas target stable during file browsing and transfer operations.

### Collapse/Expand sizing (`.vnc-auth-panel` / `.vnc-screen-shell`)

- **Expanded** (`.vnc-auth-panel` without `.collapsed`): grows to fit the
  Node/VM dropdowns, Connect/Disconnect/Logout buttons, and any TLS/error
  notices, capped at `max-height: min(56vh, 640px)` with its own
  `overflow-y: auto` when the available window height is short.
- **Collapsed** (`.vnc-auth-panel.collapsed`): shrinks to its heading strip;
  the sibling `.vnc-screen-shell` gets `flex: 0 0 80%` via
  `.vnc-display-split.controls-collapsed .vnc-screen-shell`, i.e. the VNC
  screen claims 80% of `.vnc-reader`'s available height.
- Connecting a VNC session auto-collapses Connection Controls
  (`rfb.addEventListener("connect", ...)` calls `setControlsOpen(false)`).

### `proxmox-vnc.tsx` reference

**Module-level helpers**

| Name | Purpose |
|---|---|
| `vmSshProfileId(entryId, node, vmid)` / `hostSshProfileId(entryId)` | Synthetic SSH profile ids (`vncvm:<entryId>:<node>:<vmid>` / `vncjump:<entryId>`) used as OS-keyring keys for the selected VM's SSH password and the Proxmox host's jump-SSH password, via the same `ssh_save_password`/`ssh_forget_password`/`ssh_has_password` commands a regular Terminal SSH entry uses. |
| `proxmoxHostFromBaseUrl(baseUrl)` | Extracts the hostname from a Proxmox entry's `https://host:port` base URL (used as the jump-SSH host). |
| `formatFileSize(bytes)` | Human-readable file size (`B`/`KB`/`MB`/…). |
| `formatModifiedDate(millis)` | Locale date/time string for a file's modified timestamp. |
| `transferModeLabel(mode)` | Human label for a `VncTransferMode` (e.g. `"SFTP (direct)"`, `"Guest Agent (limited)"`). |
| `formatQueueDetailProgress(progress)` | Renders a queue item's `(NN%) · rate · ETA` detail suffix from a `QueueProgress`. |

**`VncEntries` (left sidebar component)**

Renders either the Proxmox entries list (Add/Edit/Remove, Login/Logout,
`MobileChoiceMenu` quick-switch) or, when `fileBrowser.visible` is true, the
remote file browser: "← Entries" back button + reachability badge,
Upload/Download/Refresh toolbar + breadcrumb, detect/transfer/list error
notices, the multi-select `.file-table` (reusing the exact same
`.file-table`/`.file-row`/`.selection-column` styling as LOCATION mode), and
the inline transfer queue. All of its file-browser behavior is driven by
the `FileBrowserProps` passed down from `ProxmoxVncWorkspace` -- this
component itself holds no state.

**`ProxmoxVncWorkspace` (top-level component) -- state**

| State | Purpose |
|---|---|
| `password` / `loading` / `error` / `status` | Proxmox web-session login form + VNC connection status text. |
| `credentialRequest` / `directPassword` / `accountPassword` / `credentialNotice` | Current negotiated Direct VNC prompt, separate credential drafts, and keyring notices. |
| `vms` | VM list for the authenticated session (`proxmox_list_vms_session`). |
| `controlsOpen` | Connection Controls expanded/collapsed (drives `.vnc-auth-panel`/`.vnc-display-split` classes -- see sizing above). |
| `vmSshSettingsOpen` | Opens the selected VMID's VM SFTP settings in a floating window; it resets closed whenever the VM profile changes. |
| `isFullscreen` / `viewOnly` | VNC screen fullscreen + input-blocked state. |
| `authSessions` | Map of `entryId -> Proxmox session id`, so multiple entries can stay logged in independently. |
| `entryPaneWidth` / `entryPaneCollapsed` | Left sidebar's resizable width (persisted to `localStorage`) and collapsed state. |
| `transferMode` / `transferError` / `guestIp` | File-transfer route detection result (`VncTransferMode`) and the reachable IP it settled on. |
| `qemuAgentStatus` | Independent QEMU Guest Agent health state (`unknown`, `checking`, `up`, `down`, or `not-applicable`) shown beside the selected VM's SFTP profile. A successful ping enables the Guest Agent route even when network-interface discovery or VM SFTP credentials are unavailable. |
| `remotePath` / `remoteFiles` / `remoteFilesLoading` / `remoteFilesError` / `selectedRemotePaths` | Current remote directory listing and the user's multi-selection for download. |
| `vncQueue` / `progressSamplesRef` | Upload/download transfer queue and the rolling byte/time samples used to compute rate + ETA. |

**`ProxmoxVncWorkspace` -- functions**

| Function | Purpose |
|---|---|
| `stopEntryPaneResize` / `resizeEntryPane` / `beginEntryPaneResize` | Drag-resize handlers for the left sidebar's width. |
| `resetTransferState` | Clears all file-transfer state (mode, path, listing, selection, queue) -- called on disconnect/entry switch. |
| `stopConnection(updateStatus?)` | Tears down the current VNC session (cancels a pending connection, disconnects the RFB client, clears VM list + view-only + transfer state). |
| `toggleFullscreen` | Requests/exits fullscreen on the VNC screen shell. |
| `updatePassword` | Updates the Proxmox login password draft + persists it to the workspace's secret store. |
| `loginEntry` / `logoutEntry` | Proxmox web-session login/logout (`proxmox_login`/`proxmox_logout`). |
| `loadVms` | Fetches the VM list for the authenticated session. |
| `detectTransferMode` | Checks QEMU Guest Agent health independently, then performs profile-gated direct-sftp → jump-sftp probing; without a VM SFTP profile it skips automatic SSH probes and uses Guest Agent when its ping is up. It sets `transferMode`/`guestIp`/`transferError`. |
| `buildSshProfile` | Builds the `SshTransferProfile` (host/port/username/key, plus jump-host fields for `jump-sftp`) passed to `ssh_list_directory`/`ssh_upload_path`/`ssh_download_path`. |
| `loadRemoteFiles(path)` | Lists a remote directory via the Guest Agent or SSH, depending on `transferMode`. |
| `selectRemotePath(path)` | Navigates the file browser into a directory (used by both the file table's folder buttons and its ".. (up)" row). |
| `toggleRemoteSelection(path)` | Toggles a file's checkbox in `selectedRemotePaths`. |
| `addQueueItem` / `patchQueueItem` / `removeQueueItem` / `updateQueueItemProgress` | Transfer queue CRUD + progress-event handling (`proxmox-agent-upload-progress`/`-download-progress` Tauri events). |
| `executeUpload` / `runUpload` / `pickAndUpload` | Upload one file (with retry via `classifyQueueError`/`retryDelayMs`), queue it, and the file-picker entry point. |
| `executeDownload` / `runDownload` / `pickAndDownload` | Same, for downloads (rejects directory downloads under `guest-agent`, which has no directory API). |
| `connect` | Starts a VNC session: requests a relay ticket, dynamically imports noVNC, wires up the `RFB` instance and its event listeners (`connect` auto-collapses Connection Controls and kicks off `detectTransferMode`). |
| `credentialRequest.submit` / `forgetDirectCredential` | Submit current requested credentials once, or forget only the prompt's selected keyring entry. |
| `selectEntry` | Switches the active Proxmox VNC entry (stops any existing connection first). |
| `toggleViewOnly` | Flips the VNC session between interactive and view-only. |

### `proxmox-vnc.css` class map

| Selector | Purpose |
|---|---|
| `.vnc-workspace`, `.vnc-entry-pane-shell`, `.vnc-main-pane-collapse-controls` | Top-level two-pane layout + the sidebar collapse/expand chevrons. |
| `.vnc-entry-pane`, `.vnc-entry-list`, `.vnc-entry`, `.vnc-entry-auth` | Entries-list mode: entry rows, Login/Logout panel. |
| `.vnc-entry-pane-files`, `.vnc-entry-back`, `.vnc-reachability-status` | File-browser mode: sidebar wrapper, back button, mode badge (`data-mode` drives the success/danger color variants). |
| `.vnc-files-toolbar`, `.vnc-files-breadcrumb`, `.vnc-files-table-wrap`, `.vnc-files-empty`, `.vnc-file-name-cell`, `.vnc-transfer-queue` | File-browser toolbar, path breadcrumb, the file table's scroll container, empty state, name cell, and the queue list. |
| `.vnc-reader`, `.vnc-reader-heading`, `.vnc-session-status` | Right-side wrapper, heading row, VNC session status pill. |
| `.vnc-display-split`, `.vnc-auth-panel(.collapsed)`, `.vnc-screen-shell(.fullscreen)`, `.vnc-screen` | Connection Controls ⇄ VNC screen column layout -- see [Collapse/Expand sizing](#collapseexpand-sizing-vnc-auth-panel--vnc-screen-shell) above. |
| `.vnc-auth-heading`, `.vnc-auth-grid`, `.vnc-actions`, `.vnc-warning` | Connection Controls' own heading, Node/VM dropdown grid, action buttons, TLS warning. |
| `.vnc-display-toolbar` | The floating Ctrl+Alt+Del/Focus/View-only/Fullscreen toolbar overlaid on the VNC screen. |

## Add/Edit Proxmox VNC Entry modal (`main.tsx` + `styles/layout/workspace-dialogs.css`)

The modal (`.vnc-entry-modal`) pages between the Proxmox host identity and
the entry-scoped Host SSH (jump) settings. VM SSH settings are intentionally
handled in Connection Controls because they belong to the selected guest.
The tab state in `main.tsx` is `vncEntryModalTab: "default" | "hostSsh"`,
reset to `"default"` whenever the dialog opens (`openAddVncEntryDialog`/
`openEditVncEntryDialog`):

| Tab button | Section shown |
|---|---|
| **Host Entry** (default) | Name, Proxmox host/port, username + realm, PVE version, Ignore-TLS checkbox. |
| **Host SSH (jump)** | Host SSH username/port/private-key/password, "Install SSH key on host". |

`.vnc-entry-modal-tabs`/`.vnc-entry-modal-tab(.active)` in
`workspace-dialogs.css` style the three pill buttons (same visual language
as other pill-tab controls in the app). Cancel/Remove/Save stay outside the
tabbed area so they're reachable regardless of which section is open.

Each selected VM has its own VM SFTP profile, keyed by the Proxmox entry, node,
and VMID. Connection Controls shows this profile as a compact VM SFTP card with
the VM name/ID and reachability status; the editable fields open in a VMID-
specific floating window so they do not expand the main controls panel. The
profile contains the VM username, SSH port, private key path, and fallback IP.
Its password is stored in the OS credential store under the same VM-specific
key. A new VM does not trigger a file-transfer probe automatically; the user
can save its profile or explicitly choose **Try Host Jump** from the floating
window. If that button is not used, the left pane remains on the Proxmox Entry
list.

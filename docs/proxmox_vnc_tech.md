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

## Proxmox VNC flow (`pane/PaneDock.tsx`, `features/vnc/`, `proxmox-vnc.tsx`)

### Entry → VM picker → VNC screen

The dock's **Functions → VNC** menu contains **Entries**, **Direct mode**, and
**Entry Manager**. Entries are grouped by Workspace, like Terminal's SSH list.
Selecting a Proxmox entry reads its password from the OS credential store and
logs in without an extra Login action. If no password is saved, the app opens
the Workspace Manager with that entry's edit form and password field; saving a
password resumes login and VM discovery.

Each entry has a `vnc-picker:<entryId>` pane with Node/VM selectors and
Connect. Connect creates a new `vnc-screen:<sessionId>` pane containing only
that connection's VNC display and controls. The picker remains independently
available. Closing a screen releases its RFB client and relay; picker and
screen windows are transient and are never restored from persisted geometry.

**Direct mode** opens a separate setup pane for host/port. Connect opens its
own VNC screen pane. Direct mode uses a local one-time WebSocket relay whose
upstream is the configured TCP VNC endpoint; it skips Proxmox discovery and
file-transfer detection.

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
inside the active VNC fullscreen root when needed. Continue submits the current complete draft once;
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
Functions → VNC → Entries                     -- dock menu grouped by Workspace
├── vnc-picker:<entryId>                      -- Node/VM selection + Connect
└── vnc-screen:<sessionId>                    -- one noVNC display and its controls
    └── Files button (upper-left, Proxmox only)
        └── vnc-files:<sessionId>               -- separate file list and transfer queue
```

The screen owns the noVNC RFB client and file-transfer detection/queue state.
The Files pane reads that screen's transfer state and sends actions back to the
same owner. Closing Files only unmounts its view; it does not close the RFB
client or clear the queue. Closing the screen closes its associated Files pane.
Direct VNC screens do not expose a Files button.

### Independent pane sizing and controls

- The VM picker owns Node/VM selection, VM SFTP settings, Connect, and Logout.
- The VNC screen fills its pane with the noVNC canvas; Disconnect and Reconnect
  are in the heading, with the existing drawer for Focus, View only,
  Ctrl+Alt+Del, and Fullscreen.
- The compact Files button sits in the heading at upper left, outside the guest
  canvas so it does not cover the remote desktop.
- Each Files pane uses its own window bounds and scroll containers for the file
  table and transfer queue.

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
| `loginProxmoxVncEntry(entry, operations)` (`VncWorkspaceController.tsx`) | Checks the credential store, authenticates, lists VMs, and logs out if discovery fails. |

**`VncVmPickerPane` (`features/vnc/VncWorkspaceController.tsx`)**

Renders one authenticated Proxmox entry's node and VM selectors. Selecting a
guest updates that entry's saved node/VMID; Connect passes the selected VM to
the app-level screen-window creator. Its VM SFTP settings dialog stores the
VM profile in Workspace entry data and the password in the OS credential
store.

**`ProxmoxVncScreenPane` (`proxmox-vnc.tsx`)**

Owns one fixed Proxmox VM or Direct VNC endpoint, noVNC connection lifecycle,
the screen toolbar, and the transfer-detection/queue runtime. Its upper-left
Files action opens a sibling Files window using the same screen session id.

**`VncFileTransferPane` (`features/vnc/VncFileTransferPane.tsx`)**

Renders the path, reachability status, Upload/Download/Refresh and Try Host
Jump actions, multi-select file table, errors, and transfer queue. Its data and
actions are supplied by the corresponding VNC screen, so it has no separate
VM identity or network connection.

**`ProxmoxVncWorkspace` (top-level component) -- state**

| State | Purpose |
|---|---|
| `password` / `loading` / `error` / `status` | Legacy combined workspace login state plus per-screen VNC connection status. |
| `credentialRequest` / `directPassword` / `accountPassword` / `credentialNotice` | Current negotiated Direct VNC prompt, separate credential drafts, and keyring notices. |
| `vms` | VM list passed from the app-level authenticated Entry session (`proxmox_list_vms_session`). |
| `isFullscreen` / `viewOnly` | VNC screen fullscreen + input-blocked state. |
| `authSessions` | Legacy component's entry/session map. The active flow keeps Proxmox sessions in `main.tsx`, keyed by Entry. |
| `screenMode` / `screenSessionId` | Identifies this independent screen and whether its source is Proxmox or Direct VNC. |
| `entryPaneWidth` / `controlsOpen` / `vmSshSettingsOpen` | Retained by the legacy combined-workspace path; the new flow places VM settings in the picker and keeps the screen pane independent. |
| `transferMode` / `transferError` / `guestIp` | File-transfer route detection result (`VncTransferMode`) and the reachable IP it settled on. |
| `qemuAgentStatus` | Independent QEMU Guest Agent health state (`unknown`, `checking`, `up`, `down`, or `not-applicable`) shown beside the selected VM's SFTP profile. A successful ping enables the Guest Agent route even when network-interface discovery or VM SFTP credentials are unavailable. |
| `remotePath` / `remoteFiles` / `remoteFilesLoading` / `remoteFilesError` / `selectedRemotePaths` | Current remote directory listing and the user's multi-selection for download. |
| `vncQueue` / `progressSamplesRef` | Upload/download transfer queue and the rolling byte/time samples used to compute rate + ETA. |

**`ProxmoxVncWorkspace` -- functions**

| Function | Purpose |
|---|---|
| `resetTransferState` | Clears this screen's file-transfer state (mode, path, listing, selection, queue) on disconnect. |
| `stopConnection(updateStatus?)` | Tears down this screen's VNC session (cancels a pending connection and disconnects its RFB client). |
| `toggleFullscreen` | Requests/exits fullscreen on the VNC screen shell. |
| `detectTransferMode` | Checks QEMU Guest Agent health independently, then performs profile-gated direct-sftp → jump-sftp probing; without a VM SFTP profile it skips automatic SSH probes and uses Guest Agent when its ping is up. It sets `transferMode`/`guestIp`/`transferError`. |
| `buildSshProfile` | Builds the `SshTransferProfile` (host/port/username/key, plus jump-host fields for `jump-sftp`) passed to `ssh_list_directory`/`ssh_upload_path`/`ssh_download_path`. |
| `loadRemoteFiles(path)` | Lists a remote directory via the Guest Agent or SSH, depending on `transferMode`. |
| `selectRemotePath(path)` | Navigates the file browser into a directory (used by both the file table's folder buttons and its ".. (up)" row). |
| `toggleRemoteSelection(path)` | Toggles a file's checkbox in `selectedRemotePaths`. |
| `addQueueItem` / `patchQueueItem` / `removeQueueItem` / `updateQueueItemProgress` | Transfer queue CRUD + progress-event handling (`proxmox-agent-upload-progress`/`-download-progress` Tauri events). |
| `executeUpload` / `runUpload` / `pickAndUpload` | Upload one file (with retry via `classifyQueueError`/`retryDelayMs`), queue it, and the file-picker entry point. |
| `executeDownload` / `runDownload` / `pickAndDownload` | Same, for downloads (rejects directory downloads under `guest-agent`, which has no directory API). |
| `connect` | Starts this pane's VNC session: requests a relay ticket, dynamically imports noVNC, and wires up the owned `RFB` instance. A successful Proxmox connection starts transfer detection. |
| `credentialRequest.submit` / `forgetDirectCredential` | Submit current requested credentials once, or forget only the prompt's selected keyring entry. |
| `toggleViewOnly` | Flips the VNC session between interactive and view-only. |

### `proxmox-vnc.css` class map

| Selector | Purpose |
|---|---|
| `.vnc-picker-pane`, `.vnc-picker-controls`, `.vnc-picker-actions` | Independent Node/VM picker and Direct VNC setup layouts. |
| `.vnc-workspace.vnc-screen-only`, `.vnc-reader`, `.vnc-screen-shell`, `.vnc-screen` | VNC screen pane fills its window with the remote display. |
| `.vnc-files-open-button`, `.vnc-reader-title-group` | Small upper-left Files launcher and the screen title layout. |
| `.vnc-files-pane`, `.vnc-files-toolbar`, `.vnc-files-breadcrumb`, `.vnc-files-table-wrap`, `.vnc-transfer-queue` | Independent VM file-transfer pane, table, path, toolbar, and transfer queue. |
| `.vnc-display-toolbar` | The drawer for Ctrl+Alt+Del/Focus/View-only/Fullscreen over the VNC screen. |

## Add/Edit Proxmox VNC Entry modal (`main.tsx` + `styles/layout/workspace-dialogs.css`)

The modal (`.vnc-entry-modal`) pages between the Proxmox host identity and
the entry-scoped Host SSH (jump) settings. The Host Entry page includes the
Proxmox account password field; the secret is written only to the system
credential store. VM SSH settings are handled by the VM picker because they
belong to the selected guest.
The tab state in `main.tsx` is `vncEntryModalTab: "default" | "hostSsh"`,
reset to `"default"` whenever the dialog opens (`openAddVncEntryDialog`/
`openEditVncEntryDialog`):

| Tab button | Section shown |
|---|---|
| **Host Entry** (default) | Name, Proxmox host/port, username + realm, PVE version, Ignore-TLS checkbox, Proxmox password. |
| **Host SSH (jump)** | Host SSH username/port/private-key/password, "Install SSH key on host". |

`.vnc-entry-modal-tabs`/`.vnc-entry-modal-tab(.active)` in
`workspace-dialogs.css` style the pill buttons (same visual language
as other pill-tab controls in the app). Cancel/Remove/Save stay outside the
tabbed area so they're reachable regardless of which section is open.

Each selected VM has its own VM SFTP profile, keyed by the Proxmox entry, node,
and VMID. **VM SFTP settings** in the picker edit the VM username, SSH port,
private-key path, fallback IP, and password. Its password is stored in the OS
credential store under the same VM-specific key. File-route detection begins
after VNC connects; when a jump attempt is needed, **Try Host Jump** is in the
independent Files pane.

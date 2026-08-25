# Desktop Frontend Architecture (fileapi_ui)

This document is a technical reference for the Tauri desktop client's
frontend (`fileapi_ui/src`) -- what the shared CSS design tokens mean and
where they're used, and what each function/component in the more involved
modules is responsible for. It's meant to be extended over time; the
Proxmox VNC workspace (`proxmox-vnc.tsx`/`proxmox-vnc.css`) is documented in
full below since it's the most recently reworked area (T-220/T-221).

## Tech stack

| Layer | Technology | Notes |
|---|---|---|
| UI framework | React 18 + TypeScript | Function components + hooks only, no class components. |
| Build tool | Vite | `npm run dev` / `npm run build` (`tsc --noEmit && vite build`). |
| Desktop shell | Tauri 2 (Rust) | `src-tauri/`; the webview calls Rust `#[tauri::command]`s via `@tauri-apps/api/core`'s `invoke()`. |
| Terminal | xterm.js (`@xterm/xterm` + `addon-fit`) | SSH terminal tabs. |
| VNC | noVNC (`public/noVNC`) | Loaded at runtime via a dynamic `import()` of `noVNC/core/rfb.js` so it never enters Vite's module graph (it's a plain public asset, not an npm package). |
| Styling | Plain CSS with custom properties (design tokens) | No CSS framework/Tailwind; see [CSS design tokens](#css-design-tokens-stylestokenscss) below. One `*.css` file per feature area, imported from `styles/index.css` or lazily alongside its feature's `*.tsx` (e.g. `proxmox-vnc.css` next to `proxmox-vnc.tsx`). |

## CSS design tokens (`styles/tokens.css`)

Every color, spacing, font-size, and control-height value used across the
desktop UI should reference one of these custom properties instead of a
literal value, so the Auto/Mobile("Large")/theme profiles stay consistent.
`:root` defines the tokens; `styles/theme/*.css` (e.g. `starship-bridge.css`)
supplies the underlying `--bridge-*` palette that most color tokens alias.

| Token | Meaning | Typical usage |
|---|---|---|
| `--color-bg` | App background (darkest). | Page/workspace backgrounds. |
| `--color-bg-panel` | Panel background (semi-transparent). | Sidebars, cards (`.vnc-entry-pane`, `.rest-entry-pane`). |
| `--color-bg-panel-strong` | Denser panel background. | Nested "well" areas inside a panel (`.vnc-entry-auth`, toolbar buttons). |
| `--color-bg-popover` | Popover/menu surface. | Dropdown menus, context menus. |
| `--color-text` | Primary text color. | Headings, active labels. |
| `--color-text-muted` | Secondary/help text color. | `<small>` help text, breadcrumbs, placeholders. |
| `--color-primary` | Accent/cyan brand color. | Hover borders, focus rings, links. |
| `--color-secondary` | Secondary accent (blue). | Gradients (e.g. active entry row background). |
| `--color-success` | Success/green status color. | "direct-sftp"/"jump-sftp" reachability badge. |
| `--color-warning` | Warning/amber status color. | Active tab/pill buttons, session status badge. |
| `--color-danger` | Danger/red status color. | "unavailable" reachability badge, error notices. |
| `--color-border` | Default 1px border color. | Every panel/input/button border. |
| `--color-border-strong` | Brighter border for emphasis. | Rarely used directly; mostly via `--dropdown-border` etc. |
| `--space-1` … `--space-6` | Spacing scale (3.2px → 25.6px, roughly a 1.6x ramp). | `gap`, `padding`, `margin` everywhere; prefer the smallest token that fits instead of a literal px value. |
| `--font-size-base` / `--font-size-small` / `--font-size-heading` | Fluid (`clamp()`) type scale for the Auto profile. | Body text / helper text / section headings. |
| `--font-size-mobile-base` / `--font-size-mobile-small` / `--font-size-mobile-heading` | Fixed type scale for the Mobile/Large profile (see note below). | Applied under `.explorer.ui-layout-mobile`. |
| `--control-height-base` | Fluid control height (Auto profile). | Buttons/inputs outside Mobile/Large. |
| `--control-height-mobile` | Fixed 32px control height. | Buttons/inputs that should stay a constant height regardless of profile (most toolbar buttons use this so every button in the app matches). |
| `--control-height-mobile-lg` | Fixed 35.2px "comfortable" touch height. | Mobile/Large-only controls (dropdown options, `.vnc-entry`, `.vnc-entry-modal-tab` under Large profile overrides). |
| `--icon-size` / `--icon-size-lg` | Icon glyph sizes. | Inline icons vs. larger pane-collapse chevrons. |
| `--radius-sm` / `--radius-md` | Border-radius scale. | Small controls vs. panels/modals. |
| `--shadow-panel` / `--shadow-inset` / `--shadow-glow` | Elevation/glow shadows. | Panel drop shadow, inset highlight, focus glow. |
| `--transition-fast` / `--motion-fast` / `--motion-base` | Animation durations. | Hover/focus transitions. |
| `--z-dropdown` / `--z-context` / `--z-modal` / `--z-toast` | Stacking order. | Keeps popovers/menus/modals/toasts layered correctly relative to each other. |
| `--dropdown-*` | Shared contract for every dropdown-like popover (`Dropdown`, `ContextPicker`, `MobileChoiceMenu`, command-bar overflow menu). | So all popovers look interchangeable instead of each hand-picking base tokens. |

**Important:** despite the class name `ui-layout-mobile` and the CSS
comments that say "mobile", this profile is **not** a phone-sized layout --
per project convention it's the **"Large" profile**: the same desktop
layout with every control, icon, and text size enlarged (and some
non-essential chrome collapsed), for users who want bigger touch targets on
a normal desktop/laptop screen. Do not add actual small-screen/phone
breakpoints under this class name.

## Proxmox VNC workspace (`proxmox-vnc.tsx` + `proxmox-vnc.css`)

### Layout overview (as of T-220/T-221)

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
        ├── .vnc-auth-panel(.open|.collapsed)       -- "Connection controls": Node/VM pickers, Connect/
        │                                              Disconnect/Logout, TLS/error notices
        └── .vnc-screen-shell                       -- noVNC canvas + Ctrl+Alt+Del/Focus/View-only/Fullscreen
```

Prior to T-220 the right side had a "Screen"/"Files" tab switch that
conditionally unmounted the div holding the noVNC canvas (`screenRef`)
whenever the user switched to "Files" -- since noVNC attaches directly to
that DOM node, removing it broke the live session and the only recovery was
a full Proxmox Logout + Login cycle. The fix was structural, not a patch:
**the VNC screen and Connection Controls now always render** (no
conditional unmount), and file transfer moved entirely into the left
sidebar, which was already swapping content based on `transferMode` and
never touched the VNC screen's DOM.

### Collapse/Expand sizing (`.vnc-auth-panel` / `.vnc-screen-shell`)

Connection Controls used to have a *draggable* resize handle
(`.vnc-screen-resize`) between it and the VNC screen; two conflicting sets
of CSS rules for the same selectors left it visually broken. It's been
removed in favor of the existing Collapse/Expand button alone:

- **Expanded** (`.vnc-auth-panel` without `.collapsed`): grows to fit the
  Node/VM dropdowns, Connect/Disconnect/Logout buttons, and any TLS/error
  notices, capped at `max-height: min(56vh, 640px)` with its own
  `overflow-y: auto` for very short windows -- estimated to comfortably fit
  every control without a scrollbar in normal windows, only spilling to a
  scrollbar when the window is unusually short.
- **Collapsed** (`.vnc-auth-panel.collapsed`): shrinks to just its heading
  strip; the sibling `.vnc-screen-shell` gets `flex: 0 0 80%` via
  `.vnc-display-split.controls-collapsed .vnc-screen-shell`, i.e. the VNC
  screen claims 80% of `.vnc-reader`'s available height.
- Connecting a VNC session auto-collapses Connection Controls
  (`rfb.addEventListener("connect", ...)` calls `setControlsOpen(false)`).

### `proxmox-vnc.tsx` reference

**Module-level helpers**

| Name | Purpose |
|---|---|
| `vmSshProfileId(entryId)` / `hostSshProfileId(entryId)` | Synthetic SSH profile ids (`vncvm:<id>` / `vncjump:<id>`) used as OS-keyring keys for the VM's own SSH password and the Proxmox host's jump-SSH password, via the same `ssh_save_password`/`ssh_forget_password`/`ssh_has_password` commands a regular Terminal SSH entry uses. |
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
| `vms` | VM list for the authenticated session (`proxmox_list_vms_session`). |
| `controlsOpen` | Connection Controls expanded/collapsed (drives `.vnc-auth-panel`/`.vnc-display-split` classes -- see sizing above). |
| `isFullscreen` / `viewOnly` | VNC screen fullscreen + input-blocked state. |
| `authSessions` | Map of `entryId -> Proxmox session id`, so multiple entries can stay logged in independently. |
| `entryPaneWidth` / `entryPaneCollapsed` | Left sidebar's resizable width (persisted to `localStorage`) and collapsed state. |
| `transferMode` / `transferError` / `guestIp` | File-transfer route detection result (`VncTransferMode`) and the reachable IP it settled on. |
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
| `detectTransferMode` | Probes direct-sftp → jump-sftp → guest-agent (see [VNC file transfer](./desktop.md#vnc-file-transfer) in `desktop.md`) and sets `transferMode`/`guestIp`/`transferError`. |
| `buildSshProfile` | Builds the `SshTransferProfile` (host/port/username/key, plus jump-host fields for `jump-sftp`) passed to `ssh_list_directory`/`ssh_upload_path`/`ssh_download_path`. |
| `loadRemoteFiles(path)` | Lists a remote directory via the Guest Agent or SSH, depending on `transferMode`. |
| `selectRemotePath(path)` | Navigates the file browser into a directory (used by both the file table's folder buttons and its ".. (up)" row). |
| `toggleRemoteSelection(path)` | Toggles a file's checkbox in `selectedRemotePaths`. |
| `addQueueItem` / `patchQueueItem` / `removeQueueItem` / `updateQueueItemProgress` | Transfer queue CRUD + progress-event handling (`proxmox-agent-upload-progress`/`-download-progress` Tauri events). |
| `executeUpload` / `runUpload` / `pickAndUpload` | Upload one file (with retry via `classifyQueueError`/`retryDelayMs`), queue it, and the file-picker entry point. |
| `executeDownload` / `runDownload` / `pickAndDownload` | Same, for downloads (rejects directory downloads under `guest-agent`, which has no directory API). |
| `connect` | Starts a VNC session: requests a relay ticket, dynamically imports noVNC, wires up the `RFB` instance and its event listeners (`connect` auto-collapses Connection Controls and kicks off `detectTransferMode`). |
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

As of T-221 the modal (`.vnc-entry-modal`) pages between three sections
instead of showing every field in one long column, via
`vncEntryModalTab: "default" | "vmSsh" | "hostSsh"` state in `main.tsx`,
reset to `"default"` whenever the dialog opens (`openAddVncEntryDialog`/
`openEditVncEntryDialog`):

| Tab button | Section shown |
|---|---|
| **Host Entry** (default) | Name, Proxmox host/port, username + realm, PVE version, Ignore-TLS checkbox. |
| **VM SSH** | VM SSH username/port/private-key/password, fallback VM IP, "Install SSH key on VM". |
| **Host SSH (jump)** | Host SSH username/port/private-key/password, "Install SSH key on host". |

`.vnc-entry-modal-tabs`/`.vnc-entry-modal-tab(.active)` in
`workspace-dialogs.css` style the three pill buttons (same visual language
as other pill-tab controls in the app). Cancel/Remove/Save stay outside the
tabbed area so they're reachable regardless of which section is open.

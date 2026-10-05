# SSH Terminal feature

Every SSH entry has its own terminal. It is shown either in the main window as an `ssh:<entryId>` pane window or in a separate native Tauri window ("Open a new Window"); both use the same logic and header.

- `useSshEntryTerminal.ts` owns one entry's connection (connect, cancel, disconnect, reconnect), xterm/SSH event routing, recording and Save Log.
- `SshEntryTerminalView.tsx` renders the header (entry name, status, Connect/Disconnect, Record, Save Log), the xterm host and the Save Log name dialog. `variant="native"` keeps the dark native look, `variant="pane"` follows the app theme.
- `SshEntryPane.tsx` is the body of an `ssh:<entryId>` pane window; `SshTerminalPopup.tsx` is the shell of the native window (title, close request, `ssh-popup-state` reports).
- `useTerminalLifecycle.ts` creates and keeps the xterm instance, clipboard/selection/paste handling and resize. `useSshEventBridge.ts` routes the Rust `ssh-output` / `ssh-exit` events.
- `terminal-contracts.ts` and `terminal-utils.ts` contain shared data contracts and pure terminal helpers.

Workspace Manager, operation-log policy, Transfer Queue state, Viewer state, and SSH entry persistence remain app-level responsibilities in `main.tsx`. The terminal communicates with those areas through callbacks (`onStateChange`, `onOperationLog`) and narrow data props; it does not call Workspace Manager state setters directly. SSH entries are chosen from the dock's Terminal menu (`pane/PaneDock.tsx`), which offers Open a new Window or Open SSH per entry; the terminal windows themselves contain no entry list and no tabs.

The Rust SSH IPC contract is unchanged.

## Clipboard: left-click copy, right-click paste, OSC 52

`useTerminalLifecycle.ts` copies selections to the real system clipboard through the desktop clipboard path. OSC 52 clipboard-set requests are handled through the same path:

- A local left-click drag selection (xterm's own `getSelection()`, copied to the system clipboard on mouse-up).
- An OSC 52 clipboard-set request (`decodeOscClipboardSet`) from the remote program. This matters for full-screen SSH-side TUIs that grab the mouse for their own selection UI (xterm.js disables its native selection while a program owns the mouse) -- those programs use OSC 52 to hand their selection to the *real* system clipboard.

Right-click and `Ctrl+V`/`Meta+V` read the real system clipboard instead of allowing xterm.js to send the shortcut as terminal input. The paste is dispatched to the terminal instance that received the event. Clipboard `CRLF` line endings are normalized to `LF` without flattening the content. When the remote application has enabled bracketed paste, xterm.js keeps multiline input together for review before the user presses Enter. If bracketed paste is not enabled, multiline paste is rejected with no bytes sent because the remote console may interpret each line break as Enter and execute multiple commands.

A left-button selection is copied after xterm.js completes its selection, even when the pointer is released outside the terminal host. Temporary document-level mouseup tracking belongs to the terminal that started the selection and is cancelled on right-button input, blur, pointer cancellation, close, and unmount, so it cannot overwrite the clipboard from an old terminal. Clicking the terminal focuses its xterm so typing can begin without a second click.

OSC 52's *read* direction (`Pd === "?"`, the remote program asking the terminal to send back the current clipboard contents) is deliberately never answered -- doing so would let any remote shell/program silently exfiltrate whatever is on the local clipboard.

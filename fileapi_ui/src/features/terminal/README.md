# SSH Terminal feature

The Terminal feature is split into three layers:

- `TerminalWorkspace.tsx` renders the Terminal dock and receives app actions through props.
- `useSshTerminal.ts` owns browser-side xterm/SSH event routing and recording stream handling.
- `terminal-contracts.ts` and `terminal-utils.ts` contain shared data contracts and pure terminal helpers.

Workspace Manager, operation-log policy, Transfer Queue state, Viewer state, and SSH entry persistence remain app-level responsibilities in `main.tsx`. The Terminal feature communicates with those areas through callbacks and narrow data props; it does not call Workspace Manager state setters directly.

The Terminal is mounted in its own fixed viewport layer, independently of Location, REST API, and VNC flex layouts. In its normal state it is anchored to the bottom of the window; when collapsed, only the bottom Restore bar remains. The Workspaces quick list can be collapsed to give the active xterm host the full terminal width. The active terminal is re-fitted and its remote PTY size is synchronized after that layout change. Terminal height resizing is clamped to the space below the application Titlebar; reaching that maximum opens the Terminal as an overlay below the Titlebar, covering the command bar, navigation, workspace, and status bar. The top resizebar remains available in the maximized overlay, so dragging it down restores a normal Terminal height.

The Rust SSH IPC contract is unchanged.

## Clipboard: left-click copy, right-click paste, OSC 52

`useTerminalLifecycle.ts` copies selections to the real system clipboard through the desktop clipboard path. OSC 52 clipboard-set requests are handled through the same path:

- A local left-click drag selection (xterm's own `getSelection()`, copied to the system clipboard on mouse-up).
- An OSC 52 clipboard-set request (`decodeOscClipboardSet`) from the remote program. This matters for full-screen SSH-side TUIs that grab the mouse for their own selection UI (xterm.js disables its native selection while a program owns the mouse) -- those programs use OSC 52 to hand their selection to the *real* system clipboard.

Right-click and `Ctrl+V`/`Meta+V` read the real system clipboard instead of allowing xterm.js to send the shortcut as terminal input. The paste is dispatched to the terminal instance that received the event, so content copied in one SSH tab can be pasted into another SSH tab. Clipboard `CRLF` line endings are normalized to `LF` without flattening the content. When the remote application has enabled bracketed paste, xterm.js keeps multiline input together for review before the user presses Enter. If bracketed paste is not enabled, multiline paste asks for confirmation because the remote console may interpret each line break as Enter and execute multiple commands.

OSC 52's *read* direction (`Pd === "?"`, the remote program asking the terminal to send back the current clipboard contents) is deliberately never answered -- doing so would let any remote shell/program silently exfiltrate whatever is on the local clipboard.

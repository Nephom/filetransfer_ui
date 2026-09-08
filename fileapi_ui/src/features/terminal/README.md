# SSH Terminal feature

The Terminal feature is split into three layers:

- `TerminalWorkspace.tsx` renders the Terminal dock and receives app actions through props.
- `useSshTerminal.ts` owns browser-side xterm/SSH event routing and recording stream handling.
- `terminal-contracts.ts` and `terminal-utils.ts` contain shared data contracts and pure terminal helpers.

Workspace Manager, operation-log policy, Transfer Queue state, Viewer state, and SSH entry persistence remain app-level responsibilities in `main.tsx`. The Terminal feature communicates with those areas through callbacks and narrow data props; it does not call Workspace Manager state setters directly.

The Rust SSH IPC contract is unchanged.

## Clipboard: left-click copy, right-click paste, OSC 52

`useTerminalLifecycle.ts` copies selections to the real system clipboard through the desktop clipboard path. OSC 52 clipboard-set requests are handled through the same path:

- A local left-click drag selection (xterm's own `getSelection()`, copied to the system clipboard on mouse-up).
- An OSC 52 clipboard-set request (`decodeOscClipboardSet`) from the remote program. This matters for full-screen SSH-side TUIs that grab the mouse for their own selection UI (xterm.js disables its native selection while a program owns the mouse) -- those programs use OSC 52 to hand their selection to the *real* system clipboard.

Right-click (a `contextmenu` listener) reads the real system clipboard instead of showing the WebView's native context menu, the classic terminal-emulator convention (PuTTY, most Linux terminals). Clipboard line breaks are converted to spaces for this path, so right-click paste cannot submit Enter or immediately execute a pasted command. The user can still press Enter manually after reviewing the pasted text.

OSC 52's *read* direction (`Pd === "?"`, the remote program asking the terminal to send back the current clipboard contents) is deliberately never answered -- doing so would let any remote shell/program silently exfiltrate whatever is on the local clipboard.

# SSH Terminal feature

The Terminal feature is split into three layers:

- `TerminalWorkspace.tsx` renders the Terminal dock and receives app actions through props.
- `useSshTerminal.ts` owns browser-side xterm/SSH event routing and recording stream handling.
- `terminal-contracts.ts` and `terminal-utils.ts` contain shared data contracts and pure terminal helpers.

Workspace Manager, operation-log policy, Transfer Queue state, Viewer state, and SSH entry persistence remain app-level responsibilities in `main.tsx`. The Terminal feature communicates with those areas through callbacks and narrow data props; it does not call Workspace Manager state setters directly.

The Rust SSH IPC contract is unchanged.

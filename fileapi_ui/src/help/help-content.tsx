import type { ReactNode } from "react";

export type HelpPage = {
  id: string;
  title: string;
  summary: string;
  content: ReactNode;
};

export type HelpSection = {
  id: string;
  title: string;
  icon: HelpIconName;
  pages: HelpPage[];
};

export type HelpIconName =
  | "book"
  | "compass"
  | "folder"
  | "transfer"
  | "workspace"
  | "terminal"
  | "key"
  | "share"
  | "history"
  | "settings"
  | "wrench"
  | "info";

export function HelpIcon({ name, size = 18 }: { name: HelpIconName; size?: number }) {
  const paths: Record<HelpIconName, ReactNode> = {
    book: <><path d="M3 5.5A2.5 2.5 0 0 1 5.5 3H11v16H5.5A2.5 2.5 0 0 0 3 21z" /><path d="M21 5.5A2.5 2.5 0 0 0 18.5 3H13v16h5.5A2.5 2.5 0 0 1 21 21z" /><path d="M7 7h2M7 10h2" /></>,
    compass: <><circle cx="12" cy="12" r="8.5" /><path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8z" /></>,
    folder: <><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2h8A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" /></>,
    transfer: <><path d="M5 8h12" /><path d="m14 5 3 3-3 3" /><path d="M19 16H7" /><path d="m10 13-3 3 3 3" /></>,
    workspace: <><rect x="3" y="4" width="13" height="13" rx="1.5" /><path d="M7 20h13V8M7 8h9" /></>,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></>,
    key: <><circle cx="8" cy="15" r="3.5" /><path d="m11 12 7-7 3 3-2 2 2 2-2 2-2-2-3 3" /></>,
    share: <><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="m8.3 10.8 7.4-3.6M8.3 13.2l7.4 3.6" /></>,
    history: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2M4 5v4h4" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.7 1.7-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2h-2.4v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1L8 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H6.7v-2.4h.2a1.7 1.7 0 0 0 1.5-1A1.7 1.7 0 0 0 8.1 8L8 7.9l1.7-1.7.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5v-.2h2.4v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 8l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2v2.4h-.2a1.7 1.7 0 0 0-1.5 1z" /></>,
    wrench: <><path d="M14.5 6.5a4 4 0 0 0-5.2 5.2L4 17a2 2 0 1 0 2.8 2.8l5.3-5.3a4 4 0 0 0 5.2-5.2l-2.4 2.4-2.8-.8-.8-2.8z" /></>,
    info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></>,
  };
  return <svg className="help-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const Page = ({ children }: { children: ReactNode }) => <div className="help-page-copy">{children}</div>;
const List = ({ children }: { children: ReactNode }) => <ul>{children}</ul>;

export const helpSections: HelpSection[] = [
  {
    id: "getting-started", title: "Getting Started", icon: "compass", pages: [
      { id: "login", title: "Login and server connection", summary: "Connect nFterm to an HTTPS file server.", content: <Page><p>Enter the server address without a protocol, path, or port. The default HTTPS port is <code>9443</code>. The operating system must trust the server certificate; nFterm never bypasses TLS verification.</p><List><li>Use <strong>Sign in</strong> for the API file browser.</li><li>Use Only Terminal mode for a local explorer and SSH terminal without an API server.</li></List></Page> },
      { id: "interface", title: "Interface overview", summary: "Understand the header, panes, toolbar, and status areas.", content: <Page><p>The header contains the current account, remote Location selector, and connection status. The command bar acts on the active pane. In Split mode, the active pane indicator tells you whether actions target LOCAL or REMOTE.</p><p>The file area supports keyboard selection, marquee selection, folder navigation, search, sorting, and details/grid views.</p></Page> },
    ],
  },
  {
    id: "file-browser", title: "File Browser", icon: "folder", pages: [
      { id: "navigation", title: "Navigation and selection", summary: "Browse local and remote folders safely.", content: <Page><p>Use the folder tree or breadcrumbs to navigate. LOCAL starts in your home directory. Remote API locations and connected SSH/SFTP entries are selected from the Location menu.</p><List><li>Click a folder to open it.</li><li>Use Ctrl/Cmd-click or marquee selection for multiple items.</li><li>Use the search box to filter the current listing.</li></List></Page> },
      { id: "file-actions", title: "File actions", summary: "Create, rename, delete, open, and archive files.", content: <Page><p>The toolbar provides New folder, Rename, Delete, View, Select all, and archive actions. Safety confirmations protect delete, overwrite, recursive, and cross-source move operations. Local files can be opened or edited with the operating system tools.</p></Page> },
    ],
  },
  {
    id: "file-transfer", title: "File Transfer", icon: "transfer", pages: [
      { id: "upload-download", title: "Upload and download", summary: "Move files between LOCAL, API Remote, and SSH/SFTP.", content: <Page><p>Upload sends local selections to the current remote folder. Download writes files to the selected LOCAL folder. A single regular API file uses a direct download; folders and multiple selections are packaged as an archive.</p><p>Transfers are verified and report backend error messages instead of only HTTP status codes.</p></Page> },
      { id: "queue", title: "Transfer queue", summary: "Monitor progress, retry failures, and cancel work.", content: <Page><p>The queue records queued, running, retrying, completed, failed, cancelled, and needs-user-action states. Open the queue from the toolbar to inspect progress and error categories. Retry only after correcting the reported destination, permission, connection, or source-file problem.</p></Page> },
      { id: "drag-drop", title: "Drag and drop", summary: "Move selections between the two application panes.", content: <Page><p>Drag selections between LOCAL and REMOTE panes to stage a transfer. The application uses its internal HTML5 drag/drop path so pane-to-pane operations remain reliable. External operating-system Explorer drops are not supported.</p></Page> },
    ],
  },
  {
    id: "workspace", title: "Workspace Manager", icon: "workspace", pages: [
      { id: "workspaces", title: "Workspaces and SSH entries", summary: "Save reusable SSH connections.", content: <Page><p>A Workspace groups reusable SSH entries. Each SSH entry stores a connection name, host, port, username, and optional authentication settings.</p><p>Open Workspace Manager from the account menu to add, edit, select, or remove workspaces and SSH entries.</p></Page> },
      { id: "ssh-entry", title: "SSH entry settings", summary: "Save the connection details used by terminal and SFTP.", content: <Page><p>An SSH Entry contains a name, username, host, port, and optional private key path. Passwords are stored through the desktop credential store and are never included in workspace JSON or Help content.</p></Page> },
    ],
  },
  {
    id: "ssh-terminal", title: "SSH Terminal", icon: "terminal", pages: [
      { id: "terminal", title: "Connect and use the terminal", summary: "Open SSH sessions and work with terminal tabs.", content: <Page><p>Select an SSH Entry and open the terminal. nFterm supports multiple tabs, reconnect-aware output, terminal resizing, disconnect, and command input. SFTP browsing can be used alongside the terminal session.</p></Page> },
      { id: "sftp", title: "SFTP file operations", summary: "Browse, upload, download, and manage SSH files.", content: <Page><p>Connected SSH locations support directory listing, create directory, rename, delete, archive compression/extraction, upload, download, and drag staging. Remote paths are validated before local writes.</p></Page> },
      { id: "ssh-logs", title: "SSH log packages", summary: "Save raw output, readable text, commands, and metadata.", content: <Page><p>Recordings can be saved as a package containing raw output, plain text, command log, and metadata. The package can remain local or be uploaded through a configured API Remote Session.</p></Page> },
    ],
  },
  {
    id: "ssh-auth", title: "SSH Authentication", icon: "key", pages: [
      { id: "ssh-storage", title: "SSH storage", summary: "Find the keys and known_hosts used by nFterm.", content: <Page><p>Windows portable installations prefer the <code>.ssh</code> directory beside the nFterm executable. If that directory is not writable, nFterm falls back to <code>%USERPROFILE%\\.ssh</code>. Linux and macOS use <code>$HOME/.ssh</code>.</p><p>The current resolved path is shown by the Help runtime information. Never share private key files or passwords.</p></Page> },
      { id: "key-files", title: "Key files", summary: "Understand private keys, public keys, and known_hosts.", content: <Page><List><li><strong>Private key</strong>: stays local and proves your identity.</li><li><strong>Public key</strong>: can be installed on the server in <code>authorized_keys</code>.</li><li><strong>known_hosts</strong>: records trusted server host keys.</li></List><p>Generate a key pair with your platform SSH tools, then install the public key on the remote account. The private key path belongs in the SSH Entry.</p></Page> },
      { id: "auth-failures", title: "Authentication failures", summary: "Troubleshoot rejected keys and login failures.", content: <Page><p>Check host, port, username, private key path, file permissions, and whether the public key is installed for the correct remote user. An SSH password is the account password; a private-key passphrase unlocks the local key and is not the same thing.</p><p>For server rejected key errors, verify the server's SSH configuration, <code>authorized_keys</code> permissions, and the key algorithm accepted by the server.</p></Page> },
    ],
  },
  {
    id: "sharing", title: "Sharing", icon: "share", pages: [
      { id: "share-links", title: "Create and manage links", summary: "Share files with expiration and download controls.", content: <Page><p>Secure links open the share page and can use an optional password. Manage Share Links lets you copy, review, revoke, and clear expired or revoked links. The server remains the authority for permissions and maximum expiration.</p></Page> },
      { id: "direct-links", title: "Secure and direct links", summary: "Choose the link format for people or tools.", content: <Page><p>Use Secure share for people and password-protected pages. Use Direct link for tools that accept only a bare file URL. Direct links do not carry an Authorization header and cannot use password protection.</p></Page> },
    ],
  },
  {
    id: "logs-history", title: "Logs and History", icon: "history", pages: [
      { id: "undo", title: "Undo history", summary: "Review reliable, verifiable reversals.", content: <Page><p>Undo records are stored locally for operations that can be safely verified and reversed. Disabling undo history stops new records; it does not delete files. Clear undo history is permanent.</p></Page> },
      { id: "operation-log", title: "Operation logs", summary: "Inspect and export the audit trail.", content: <Page><p>Operation logs are JSON-lines records for file, SSH, transfer, and application events. They exclude secrets, rotate at 10 MB, and retain at most three files. Settings displays the active log path and retained files.</p></Page> },
    ],
  },
  {
    id: "settings", title: "Settings", icon: "settings", pages: [
      { id: "safety", title: "Safety confirmations", summary: "Control prompts without bypassing safeguards.", content: <Page><p>Delete, overwrite, recursive, and cross-source move confirmations can be adjusted. These preferences never bypass permissions, read-only rules, path boundaries, destination validation, or transfer verification.</p></Page> },
      { id: "preferences", title: "Interface and sharing preferences", summary: "Adjust density, logging, and share defaults.", content: <Page><p>Interface size controls spacing. Share settings define secure/direct mode and default expiration. Logging settings control whether records are written and how much diagnostic detail is retained.</p></Page> },
    ],
  },
  {
    id: "troubleshooting", title: "Troubleshooting", icon: "wrench", pages: [
      { id: "connection-problems", title: "Connection problems", summary: "Resolve login, TLS, location, and permission issues.", content: <Page><List><li>Confirm the host contains no protocol, path, or port.</li><li>Confirm the HTTPS port and operating-system certificate trust.</li><li>Check that the Location is online and your account has the required capability.</li><li>Read the notice and operation log for the server's actual error message.</li></List></Page> },
      { id: "transfer-problems", title: "Transfer problems", summary: "Recover from failed or paused transfers.", content: <Page><p>Check the queue error category, source-file changes, destination permissions, free space, and network connection. A source modified after queueing may require selecting it again. Retry after fixing the underlying issue.</p></Page> },
    ],
  },
  {
    id: "about", title: "About", icon: "info", pages: [
      { id: "about-nfterm", title: "nFterm information", summary: "View the build, release, and runtime details.", content: <Page><p>The version shown here is generated from the repository's root <code>VERSION</code>, Git commit, and <code>RELEASE_DATE</code>. Runtime and SSH storage details are resolved for this installation and are not hard-coded into the Help text.</p><div className="help-about-grid"><span>Application</span><strong>nFterm</strong><span>Version</span><strong>{import.meta.env.VITE_APP_VERSION_DISPLAY || "development"}</strong><span>Documentation</span><strong>README.md and parent docs/API</strong></div></Page> },
      { id: "support", title: "Documentation and support", summary: "Find technical references and report problems.", content: <Page><p>For server API behavior, consult the parent API contract. When reporting a problem, include the operation name, non-sensitive error message, app version, operating system, and relevant operation-log entry. Do not attach private keys, passwords, tokens, or passphrases.</p></Page> },
    ],
  },
];

export const helpPages = helpSections.flatMap((section) => section.pages);

import React from "react";

// 24x24 stroke icons for the Pane desktop (dock, taskbar, window titlebars).
// They follow currentColor so themes and active/hover states recolor them.
type IconProps = { size?: number };

const svg = (size: number | undefined, children: React.ReactNode) => (
  <svg viewBox="0 0 24 24" width={size ?? 24} height={size ?? 24} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const FunctionsIcon = ({ size }: IconProps) => svg(size, <><rect x="4" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" /></>);
export const LocationIcon = ({ size }: IconProps) => svg(size, <><path d="M3 7.5a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>);
export const LocalIcon = ({ size }: IconProps) => svg(size, <><rect x="3.5" y="4.5" width="17" height="11" rx="2" /><path d="M8 20h8M12 15.5V20" /></>);
export const RemoteIcon = ({ size }: IconProps) => svg(size, <><rect x="3.5" y="4" width="17" height="6.5" rx="1.8" /><rect x="3.5" y="13.5" width="17" height="6.5" rx="1.8" /><path d="M7.5 7.25h.01M7.5 16.75h.01" /></>);
export const SftpIcon = ({ size }: IconProps) => svg(size, <><path d="M7 9V5.5M7 5.5L4.5 8M7 5.5L9.5 8" /><path d="M17 15v3.5M17 18.5L14.5 16M17 18.5L19.5 16" /><rect x="3.5" y="11" width="6" height="2" rx="1" /><rect x="14.5" y="11" width="6" height="2" rx="1" /></>);
export const VncIcon = ({ size }: IconProps) => svg(size, <><rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M9 20.5h6M12 16.5v4" /><path d="M10 9.5l4 2.5-4 2.5z" /></>);
export const RestIcon = ({ size }: IconProps) => svg(size, <><path d="M8.5 5C6.5 5 6 6 6 7.5v2C6 11 5 12 3.5 12 5 12 6 13 6 14.5v2C6 18 6.5 19 8.5 19" /><path d="M15.5 5c2 0 2.5 1 2.5 2.5v2c0 1.500 1 2.500 2.500 2.500-1.500 0-2.500 1-2.500 2.500v2c0 1.500-.5 2.500-2.500 2.500" /></>);
export const TerminalIcon = ({ size }: IconProps) => svg(size, <><rect x="3" y="4.5" width="18" height="15" rx="2.2" /><path d="M7.5 9.5l3 2.500-3 2.500M12.5 15h4" /></>);
export const SshEntriesIcon = ({ size }: IconProps) => svg(size, <><rect x="3.500" y="3.500" width="17" height="6" rx="1.800" /><rect x="3.500" y="14.500" width="17" height="6" rx="1.800" /><path d="M7.500 6.500h.01M7.500 17.500h.01M12 9.500v5" /></>);
export const EntryManagerIcon = ({ size }: IconProps) => svg(size, <><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>);
export const ExternalWindowIcon = ({ size }: IconProps) => svg(size, <><path d="M14 4h6v6M20 4l-8 8" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></>);
export const QueueIcon = ({ size }: IconProps) => svg(size, <><path d="M12 4v11M7.500 10.500L12 15l4.500-4.500" /><path d="M5 19.500h14" /></>);
export const SettingsIcon = ({ size }: IconProps) => svg(size, <><circle cx="12" cy="12" r="3" /><path d="M19.400 15a1.700 1.700 0 0 0 .3 1.800l.1.100a2 2 0 1 1-2.800 2.800l-.1-.1a1.700 1.700 0 0 0-1.800-.3 1.700 1.700 0 0 0-1 1.500V21a2 2 0 1 1-4 0v-.1a1.700 1.700 0 0 0-1.100-1.500 1.700 1.700 0 0 0-1.800.3l-.1.100a2 2 0 1 1-2.800-2.800l.1-.1a1.700 1.700 0 0 0 .3-1.800 1.700 1.700 0 0 0-1.500-1H3a2 2 0 1 1 0-4h.1a1.700 1.700 0 0 0 1.500-1.100 1.700 1.700 0 0 0-.3-1.800l-.1-.1a2 2 0 1 1 2.800-2.800l.1.100a1.700 1.700 0 0 0 1.800.3H9a1.700 1.700 0 0 0 1-1.500V3a2 2 0 1 1 4 0v.1a1.700 1.700 0 0 0 1 1.500 1.700 1.700 0 0 0 1.800-.3l.1-.1a2 2 0 1 1 2.800 2.800l-.1.100a1.700 1.700 0 0 0-.3 1.800V9a1.700 1.700 0 0 0 1.500 1H21a2 2 0 1 1 0 4h-.1a1.700 1.700 0 0 0-1.500 1z" /></>);
export const AccountIcon = ({ size }: IconProps) => svg(size, <><circle cx="12" cy="8.500" r="3.500" /><path d="M4.500 20c.8-3.800 3.700-5.500 7.500-5.500s6.700 1.700 7.500 5.500" /></>);
export const ChevronRightSmall = ({ size }: IconProps) => svg(size ?? 14, <path d="M9 5.500L15.500 12 9 18.500" />);

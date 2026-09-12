import React from "react";

type AppShellProps = {
  className: string;
  style: React.CSSProperties;
  children: React.ReactNode;
};

export function AppShell({ className, style, children }: AppShellProps) {
  return (
    <main
      className={className}
      style={style}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </main>
  );
}

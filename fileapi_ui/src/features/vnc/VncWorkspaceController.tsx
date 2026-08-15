import React from "react";
import { ProxmoxVncWorkspace, type ProxmoxVncEntry, type ProxmoxVncSecret } from "../../proxmox-vnc";

export type VncWorkspaceControllerProps = {
  workspaceName: string;
  entries: ProxmoxVncEntry[];
  activeEntryId: string;
  secrets: Record<string, ProxmoxVncSecret>;
  onSelectEntry: (id: string) => void;
  onChangeEntries: (entries: ProxmoxVncEntry[]) => void;
  onChangeSecret: (entryId: string, secret: ProxmoxVncSecret) => void;
};

export function VncWorkspaceController(props: VncWorkspaceControllerProps) {
  return <ProxmoxVncWorkspace {...props} />;
}

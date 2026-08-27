import type { SshProfile } from "../ssh/ssh-contracts";
import type { RestApiEntry } from "../../rest-api";
import type { ProxmoxVncEntry } from "../../proxmox-vnc";

// localStorage key holding the serialized ManagedSession[] array. Read
// directly by DesktopApp's workspaceSessionId useState initializer before
// useSessionsState itself has run, so this constant stays exported here
// rather than folded away as a private detail of the hook.
export const sessionRegistryKey = "fileapi-session-registry";

export type ManagedSession = {
  id: string;
  name: string;
  sshEntries: SshProfile[];
  restApiEntries: RestApiEntry[];
  proxmoxVncEntries: ProxmoxVncEntry[];
};

export const normalizeManagedSessions = (value: unknown): ManagedSession[] => {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const item = raw as Partial<ManagedSession> & { entries?: Array<{ kind?: string; sshProfile?: SshProfile }> };
    const entries = Array.isArray(item.entries) ? item.entries : [];
    const sshEntries = Array.isArray(item.sshEntries)
      ? item.sshEntries
      : entries.filter((entry) => entry.kind === "SSH").map((entry) => entry.sshProfile).filter(Boolean) as SshProfile[];
    const restApiEntries = Array.isArray(item.restApiEntries)
      ? item.restApiEntries.map((rawEntry) => {
        const entry = rawEntry as RestApiEntry;
        const vendor = entry.vendor === "hpe" || entry.vendor === "openbmc" || entry.vendor === "none"
          ? entry.vendor
          : "none";
        return { ...entry, vendor };
      })
      : [];
    const proxmoxVncEntries = Array.isArray(item.proxmoxVncEntries) ? item.proxmoxVncEntries : [];
    return {
      id: item.id || crypto.randomUUID(),
      name: item.name || "Default",
      sshEntries,
      restApiEntries,
      proxmoxVncEntries,
    };
  });
};

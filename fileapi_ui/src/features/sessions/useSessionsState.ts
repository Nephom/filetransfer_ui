import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SshProfile } from "../ssh/ssh-contracts";
import type { RestApiEntry, RestApiSecret } from "../../rest-api";
import type { ProxmoxVncEntry, ProxmoxVncSecret } from "../../proxmox-vnc";
import {
  normalizeManagedSessions,
  sessionRegistryKey,
  type ManagedSession,
} from "./sessions-contracts";

export type SshProfileDraft = {
  id: string;
  name: string;
  host: string;
  port: string;
  username: string;
  privateKeyPath: string;
  password: string;
};

export const emptySshProfileDraft = (): SshProfileDraft => ({
  id: "", name: "", host: "", port: "22", username: "", privateKeyPath: "", password: "",
});

// Owns every piece of state behind Workspaces (the "Session Manager"): the
// list of ManagedSessions itself (each holding its own SSH/REST API/
// Proxmox VNC entries), which entry of each kind is currently active, the
// secrets loaded for REST/VNC entries, every dialog's open/draft state, and
// the legacy pre-Workspace SSH-profile fields kept only for one-time
// migration. Handlers that create/edit/remove entries live in
// useSessionsActions instead, since they also depend on cross-cutting
// DesktopApp utilities (`run`, `notify`) declared partway through
// DesktopApp's render body.
export function useSessionsState() {
  const [managedSessions, setManagedSessions] = useState<ManagedSession[]>(() => {
    try {
      const saved = localStorage.getItem(sessionRegistryKey);
      const parsed = saved ? JSON.parse(saved) : [];
      return normalizeManagedSessions(parsed);
    } catch {
      return [];
    }
  });
  const [activeRestEntryId, setActiveRestEntryId] = useState("");
  const [restSecrets, setRestSecrets] = useState<Record<string, RestApiSecret>>({});
  const [restSessionHeaders, setRestSessionHeaders] = useState<Record<string, string>>({});
  const [activeVncEntryId, setActiveVncEntryId] = useState("");
  const [vncSecrets, setVncSecrets] = useState<Record<string, ProxmoxVncSecret>>({});
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [workspaceNameDialogOpen, setWorkspaceNameDialogOpen] = useState(false);
  const [sessionFormError, setSessionFormError] = useState("");
  const [lastSavedSessionId, setLastSavedSessionId] = useState("");

  // Legacy pre-Workspace SSH profile list/selection, kept only so the
  // one-time migration effect below can fold it into managedSessions the
  // first time this version of the app runs against old localStorage data.
  const [sshProfiles, setSshProfiles] = useState<SshProfile[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("fileapi-ssh-profiles") || "[]");
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  });
  const [sshProfileId, setSshProfileId] = useState(() => sshProfiles[0]?.id || "");
  const [workspaceSessionId, setWorkspaceSessionId] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(sessionRegistryKey) || "[]");
      const sessions = normalizeManagedSessions(saved);
      return sessions.find((item) => item.sshEntries.length)?.id || "";
    } catch {
      return "";
    }
  });
  const [selectedSshEntryId, setSelectedSshEntryId] = useState("");
  const [sshProfileDraft, setSshProfileDraft] = useState<SshProfileDraft>(emptySshProfileDraft());
  const [sshPasswordSaved, setSshPasswordSaved] = useState(false);
  const [sshEntryDraftId, setSshEntryDraftId] = useState("");
  // Proxmox VNC entry file-transfer credentials (VM SSH / Host SSH jump).
  // Mirrors sshProfileDraft/sshPasswordSaved above: passwords are held only
  // transiently here for the dialog form, then written to the OS keyring
  // via ssh_save_password (keyed by vmSshProfileId/hostSshProfileId) on
  // Save, never stored in the ProxmoxVncEntry object itself.
  const [vmSshPasswordDraft, setVmSshPasswordDraft] = useState("");
  const [vmSshPasswordSaved, setVmSshPasswordSaved] = useState(false);
  const [hostSshPasswordDraft, setHostSshPasswordDraft] = useState("");
  const [hostSshPasswordSaved, setHostSshPasswordSaved] = useState(false);
  const [sessionNameDraft, setSessionNameDraft] = useState("");
  // Session Manager only shows the Workspace list/summary; adding or
  // editing an SSH entry happens in its own floating dialog on top of the
  // Sessions modal. REST API and Proxmox VNC entries use the exact same
  // pattern (see openAddRestEntryDialog/openAddVncEntryDialog in
  // useSessionsActions) -- their own mode's sidebar is read-only, just for
  // selecting among already-created entries, same as the SSH terminal
  // panel's own sidebar.
  const [sshEntryDialogOpen, setSshEntryDialogOpen] = useState(false);
  const [restEntryDialogOpen, setRestEntryDialogOpen] = useState(false);
  const [restEntryDraft, setRestEntryDraft] = useState<RestApiEntry | null>(null);
  const [vncEntryDialogOpen, setVncEntryDialogOpen] = useState(false);
  const [vncEntryDraft, setVncEntryDraft] = useState<ProxmoxVncEntry | null>(null);
  // Which section of the Add/Edit Proxmox VNC Entry modal is showing --
  // "default" is the original Proxmox connection identity fields (host,
  // port, username, PVE version); "vmSsh"/"hostSsh" are the two file-
  // transfer credential sections. Splitting these into buttoned pages (see
  // T-221) keeps the modal from growing into one very long scrolling form.
  const [vncEntryModalTab, setVncEntryModalTab] = useState<"default" | "vmSsh" | "hostSsh">("default");

  useEffect(() => {
    localStorage.setItem(sessionRegistryKey, JSON.stringify(managedSessions));
  }, [managedSessions]);

  useEffect(() => {
    if (activeRestEntryId) return;
    const firstEntry = managedSessions.find((workspace) => workspace.restApiEntries.length)?.restApiEntries[0];
    if (firstEntry) setActiveRestEntryId(firstEntry.id);
  }, [activeRestEntryId, managedSessions]);

  useEffect(() => {
    if (activeVncEntryId) return;
    const firstEntry = managedSessions.find((workspace) => workspace.proxmoxVncEntries.length)?.proxmoxVncEntries[0];
    if (firstEntry) setActiveVncEntryId(firstEntry.id);
  }, [activeVncEntryId, managedSessions]);

  useEffect(() => {
    const entries = managedSessions.flatMap((workspace) => workspace.restApiEntries);
    let cancelled = false;
    void Promise.all(entries.flatMap((entry) => (["username", "password", "token", "apiKey", "cookie"] as const).map(async (kind) => {
      const value = await invoke<string | null>("rest_load_secret", { entryId: entry.id, kind }).catch(() => null);
      if (cancelled || value === null) return;
      setRestSecrets((current) => ({ ...current, [entry.id]: { ...current[entry.id], [kind]: value } }));
    })));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on entry ids only, mirroring the original inline effect.
  }, [managedSessions.map((workspace) => workspace.restApiEntries.map((entry) => entry.id).join(",")).join("|")]);

  useEffect(() => {
    const entries = managedSessions.flatMap((workspace) => workspace.proxmoxVncEntries);
    void Promise.all(entries.map(async (entry) => {
      const value = await invoke<string | null>("proxmox_load_secret", { entryId: entry.id, kind: "password" }).catch(() => null);
      if (value !== null) setVncSecrets((current) => ({ ...current, [entry.id]: { ...current[entry.id], password: value } }));
    }));
  }, [managedSessions]);

  useEffect(() => {
    localStorage.setItem("fileapi-ssh-profiles", JSON.stringify(sshProfiles));
  }, [sshProfiles]);

  // One-time migration: fold any legacy pre-Workspace SSH profiles into a
  // managedSessions entry per profile, the first time this version of the
  // app runs against old localStorage data.
  useEffect(() => {
    if (managedSessions.length || !sshProfiles.length) return;
    const makeId = () => typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const migrated = sshProfiles.map((profile) => ({
      id: makeId(),
      name: profile.name,
      sshEntries: [profile],
      restApiEntries: [],
      proxmoxVncEntries: [],
    }));
    setManagedSessions(migrated);
    setWorkspaceSessionId(migrated[0]?.id || "");
  }, [managedSessions.length, sshProfiles]);

  return {
    managedSessions, setManagedSessions,
    activeRestEntryId, setActiveRestEntryId,
    restSecrets, setRestSecrets,
    restSessionHeaders, setRestSessionHeaders,
    activeVncEntryId, setActiveVncEntryId,
    vncSecrets, setVncSecrets,
    sessionsOpen, setSessionsOpen,
    workspaceNameDialogOpen, setWorkspaceNameDialogOpen,
    sessionFormError, setSessionFormError,
    lastSavedSessionId, setLastSavedSessionId,
    sshProfiles, setSshProfiles,
    sshProfileId, setSshProfileId,
    workspaceSessionId, setWorkspaceSessionId,
    selectedSshEntryId, setSelectedSshEntryId,
    sshProfileDraft, setSshProfileDraft,
    sshPasswordSaved, setSshPasswordSaved,
    sshEntryDraftId, setSshEntryDraftId,
    vmSshPasswordDraft, setVmSshPasswordDraft,
    vmSshPasswordSaved, setVmSshPasswordSaved,
    hostSshPasswordDraft, setHostSshPasswordDraft,
    hostSshPasswordSaved, setHostSshPasswordSaved,
    sessionNameDraft, setSessionNameDraft,
    sshEntryDialogOpen, setSshEntryDialogOpen,
    restEntryDialogOpen, setRestEntryDialogOpen,
    restEntryDraft, setRestEntryDraft,
    vncEntryDialogOpen, setVncEntryDialogOpen,
    vncEntryDraft, setVncEntryDraft,
    vncEntryModalTab, setVncEntryModalTab,
  };
}

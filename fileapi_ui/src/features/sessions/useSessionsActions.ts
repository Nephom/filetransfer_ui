import { invoke } from "@tauri-apps/api/core";
import type { SshProfile } from "../ssh/ssh-contracts";
import type { RestApiEntry } from "../../rest-api";
import type { ProxmoxVncEntry } from "../../proxmox-vnc";
import { hostSshProfileId, proxmoxHostFromBaseUrl, vmSshProfileId } from "../../proxmox-vnc";
import { makeSshTabId } from "../terminal/terminal-utils";
import type { ManagedSession } from "./sessions-contracts";
import type { SshProfileDraft } from "./useSessionsState";

export type UseSessionsActionsParams = {
  run: (action: () => Promise<void>) => Promise<void>;
  notify: (message: string, duration?: number) => void;
  setNotice: React.Dispatch<React.SetStateAction<string>>;

  managedSessions: ManagedSession[];
  setManagedSessions: React.Dispatch<React.SetStateAction<ManagedSession[]>>;
  workspaceSessionId: string;
  setWorkspaceSessionId: React.Dispatch<React.SetStateAction<string>>;
  sessionNameDraft: string;
  setSessionNameDraft: React.Dispatch<React.SetStateAction<string>>;
  setSessionFormError: React.Dispatch<React.SetStateAction<string>>;
  setLastSavedSessionId: React.Dispatch<React.SetStateAction<string>>;
  setWorkspaceNameDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSessionsOpen: React.Dispatch<React.SetStateAction<boolean>>;

  sshProfiles: SshProfile[];
  setSshProfiles: React.Dispatch<React.SetStateAction<SshProfile[]>>;
  sshProfileId: string;
  setSshProfileId: React.Dispatch<React.SetStateAction<string>>;
  selectedSshEntryId: string;
  setSelectedSshEntryId: React.Dispatch<React.SetStateAction<string>>;
  sshProfileDraft: SshProfileDraft;
  setSshProfileDraft: React.Dispatch<React.SetStateAction<SshProfileDraft>>;
  setSshPasswordSaved: React.Dispatch<React.SetStateAction<boolean>>;
  sshEntryDraftId: string;
  setSshEntryDraftId: React.Dispatch<React.SetStateAction<string>>;
  setSshEntryDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;

  restEntryDraft: RestApiEntry | null;
  setRestEntryDraft: React.Dispatch<React.SetStateAction<RestApiEntry | null>>;
  setRestEntryDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  activeRestEntryId: string;
  setActiveRestEntryId: React.Dispatch<React.SetStateAction<string>>;

  vncEntryDraft: ProxmoxVncEntry | null;
  setVncEntryDraft: React.Dispatch<React.SetStateAction<ProxmoxVncEntry | null>>;
  setVncEntryDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setVncEntryModalTab: React.Dispatch<React.SetStateAction<"default" | "vmSsh" | "hostSsh">>;
  activeVncEntryId: string;
  setActiveVncEntryId: React.Dispatch<React.SetStateAction<string>>;
  vmSshPasswordDraft: string;
  setVmSshPasswordDraft: React.Dispatch<React.SetStateAction<string>>;
  vmSshPasswordSaved: boolean;
  setVmSshPasswordSaved: React.Dispatch<React.SetStateAction<boolean>>;
  hostSshPasswordDraft: string;
  setHostSshPasswordDraft: React.Dispatch<React.SetStateAction<string>>;
  hostSshPasswordSaved: boolean;
  setHostSshPasswordSaved: React.Dispatch<React.SetStateAction<boolean>>;
};

// Owns every handler behind Workspaces (the "Session Manager"): creating,
// editing, and removing Workspaces themselves and the SSH/REST API/Proxmox
// VNC entries inside them, plus the small derived values (the active
// Workspace, the REST/VNC "current Workspace" fallbacks) other DesktopApp
// domains (the terminal panel, RestApiWorkspace, VncWorkspaceController)
// read. Called after `run`/`notify` are declared in DesktopApp's render
// body, and before useSshTerminalActions -- which needs this hook's
// loadSshProfileDraft/openSessionsModal to wire its own workspace-selection
// and "open the Session manager" behaviour.
export function useSessionsActions({
  run, notify, setNotice,
  managedSessions, setManagedSessions,
  workspaceSessionId, setWorkspaceSessionId,
  sessionNameDraft, setSessionNameDraft,
  setSessionFormError, setLastSavedSessionId,
  setWorkspaceNameDialogOpen, setSessionsOpen,
  sshProfiles, setSshProfiles,
  sshProfileId, setSshProfileId,
  selectedSshEntryId, setSelectedSshEntryId,
  sshProfileDraft, setSshProfileDraft,
  setSshPasswordSaved,
  sshEntryDraftId, setSshEntryDraftId,
  setSshEntryDialogOpen,
  restEntryDraft, setRestEntryDraft, setRestEntryDialogOpen,
  activeRestEntryId, setActiveRestEntryId,
  vncEntryDraft, setVncEntryDraft, setVncEntryDialogOpen, setVncEntryModalTab,
  activeVncEntryId, setActiveVncEntryId,
  vmSshPasswordDraft, setVmSshPasswordDraft, vmSshPasswordSaved, setVmSshPasswordSaved,
  hostSshPasswordDraft, setHostSshPasswordDraft, hostSshPasswordSaved, setHostSshPasswordSaved,
}: UseSessionsActionsParams) {
  // Creates or renames a Workspace. SSH entries are added or edited
  // afterwards in their own floating dialog.
  const saveWorkspaceName = (form?: HTMLFormElement) => {
    const values = form ? new FormData(form) : null;
    const name = String(values?.get("sessionName") || sessionNameDraft).trim();
    if (!name) {
      setSessionFormError("Workspace name is required.");
      return;
    }
    if (/\s/.test(name)) {
      setSessionFormError("Workspace names cannot contain spaces.");
      return;
    }
    const existingWorkspace = managedSessions.find((item) => item.id === workspaceSessionId);
    if (managedSessions.some((item) => item.id !== existingWorkspace?.id && item.name.toLowerCase() === name.toLowerCase())) {
      setSessionFormError(`A Workspace named "${name}" already exists.`);
      return;
    }
    const makeId = () =>
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const managedSession: ManagedSession = existingWorkspace
      ? { ...existingWorkspace, name }
      : { id: makeId(), name, sshEntries: [], restApiEntries: [], proxmoxVncEntries: [] };
    setManagedSessions((current) => existingWorkspace
      ? current.map((item) => item.id === existingWorkspace.id ? managedSession : item)
      : [...current, managedSession]);
    setWorkspaceSessionId(managedSession.id);
    setSessionNameDraft(name);
    setSessionFormError("");
    setLastSavedSessionId(managedSession.id);
    setWorkspaceNameDialogOpen(false);
    notify(`Saved Workspace: ${name}`);
  };

  const openWorkspaceNameDialog = (workspace?: ManagedSession) => {
    const target = workspace || managedSessions.find((item) => item.id === workspaceSessionId);
    setWorkspaceSessionId(target?.id || "");
    setSessionNameDraft(target?.name || "");
    setSessionFormError("");
    setWorkspaceNameDialogOpen(true);
  };

  const removeSession = (sessionId: string) => {
    if (managedSessions.length === 1) return;
    setManagedSessions((current) => current.filter((item) => item.id !== sessionId));
    if (workspaceSessionId === sessionId) setWorkspaceSessionId("");
  };

  const loadSshProfileDraft = (profile: SshProfile | undefined) => {
    setSshProfileDraft(profile
      ? {
          id: profile.id,
          name: profile.name,
          host: profile.host,
          port: String(profile.port),
          username: profile.username,
          privateKeyPath: profile.privateKeyPath,
          password: "",
        }
      : { id: "", name: "", host: "", port: "22", username: "", privateKeyPath: "", password: "" });
    setSshPasswordSaved(false);
    if (profile?.id) {
      void invoke<boolean>("ssh_has_password", { entryId: profile.id })
        .then(setSshPasswordSaved)
        .catch(() => setSshPasswordSaved(false));
    }
  };

  const selectWorkspaceSession = (id: string) => {
    setWorkspaceSessionId(id);
    const workspace = managedSessions.find((item) => item.id === id);
    const profile = workspace?.sshEntries[0] || sshProfiles.find((item) => item.id === sshProfileId);
    if (profile) {
      setSshEntryDraftId(workspace?.sshEntries[0]?.id || profile.id);
      setSelectedSshEntryId(profile.id);
      setSshProfileId(profile.id);
      loadSshProfileDraft(profile);
    }
  };

  const openSessionsModal = (requestedWorkspaceId = workspaceSessionId) => {
    void run(async () => {
      const workspace = managedSessions.find((item) => item.id === requestedWorkspaceId);
      if (workspace) {
        setWorkspaceSessionId(workspace.id);
        const profile = workspace.sshEntries[0] || sshProfiles.find((item) => item.id === sshProfileId);
        setSessionNameDraft(workspace.name);
        if (profile) {
          setSshEntryDraftId(workspace.sshEntries[0]?.id || profile.id);
          setSelectedSshEntryId(profile.id);
          loadSshProfileDraft(profile);
        } else {
          setSshEntryDraftId("");
          setSelectedSshEntryId("");
          setSshProfileDraft({ id: "", name: "", host: "", port: "22", username: "", privateKeyPath: "", password: "" });
        }
      }
      setSessionFormError("");
      setSessionsOpen(true);
    });
  };

  const startNewWorkspace = () => {
    setWorkspaceSessionId("");
    setSessionNameDraft("");
    setSshEntryDraftId("");
    setSshProfileDraft({ id: "", name: "", host: "", port: "22", username: "", privateKeyPath: "", password: "" });
    setSessionFormError("");
    setWorkspaceNameDialogOpen(true);
  };

  const startNewSshEntry = () => {
    setSshEntryDraftId("");
    setSelectedSshEntryId("");
    setSshProfileDraft({ id: "", name: "", host: "", port: "22", username: "", privateKeyPath: "", password: "" });
    setSshPasswordSaved(false);
  };

  const openAddSshEntryDialog = () => {
    startNewSshEntry();
    setSessionFormError("");
    setSshEntryDialogOpen(true);
  };

  const openEditSshEntryDialog = (entry: SshProfile) => {
    setSshEntryDraftId(entry.id);
    setSshProfileId(entry.id);
    loadSshProfileDraft(entry);
    setSessionFormError("");
    setSshEntryDialogOpen(true);
  };

  const saveSshEntry = () => {
    const workspace = managedSessions.find((item) => item.id === workspaceSessionId);
    const name = sshProfileDraft.name.trim();
    const host = sshProfileDraft.host.trim();
    const username = sshProfileDraft.username.trim();
    const port = Number(sshProfileDraft.port);
    if (!workspace) {
      setSessionFormError("Save the Workspace name first, then add an SSH entry to it.");
      return;
    }
    if (!name || !host || !username || !Number.isInteger(port) || port < 1 || port > 65535) {
      setSessionFormError("Connection name, host, username, and a valid port are required.");
      return;
    }
    const wasEditing = Boolean(sshProfileDraft.id);
    const entry: SshProfile = { id: sshProfileDraft.id || makeSshTabId(), name, host, port, username, privateKeyPath: sshProfileDraft.privateKeyPath.trim() };
    setManagedSessions((current) => current.map((item) => item.id !== workspace.id ? item : {
      ...item,
      sshEntries: item.sshEntries.some((candidate) => candidate.id === entry.id)
        ? item.sshEntries.map((candidate) => candidate.id === entry.id ? entry : candidate)
        : [...item.sshEntries, entry],
    }));
    setSshProfiles((current) => current.some((item) => item.id === entry.id) ? current.map((item) => item.id === entry.id ? entry : item) : [...current, entry]);
    // Keep the just-saved entry as the "active" SSH selection for connecting
    // outside this dialog, but clear the draft/form and close the floating
    // SSH Entry dialog, returning to the Sessions modal's Workspace view.
    // This applies to both creating a new entry and updating an existing
    // one -- either way, Save returns to the Workspace.
    setSelectedSshEntryId(entry.id);
    setSshProfileId(entry.id);
    const password = sshProfileDraft.password;
    setSshEntryDraftId("");
    setSshProfileDraft({ id: "", name: "", host: "", port: "22", username: "", privateKeyPath: "", password: "" });
    setSshPasswordSaved(false);
    setSessionFormError("");
    setSshEntryDialogOpen(false);
    if (password) {
      void invoke("ssh_save_password", { entryId: entry.id, password })
        .then(() => setSshPasswordSaved(true))
        .catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    }
    notify(`${wasEditing ? "Updated" : "Added"} SSH entry: ${entry.name}`);
  };

  const forgetSshPassword = () => {
    if (!sshProfileDraft.id) return;
    void invoke("ssh_forget_password", { entryId: sshProfileDraft.id })
      .then(() => {
        setSshPasswordSaved(false);
        notify("Saved password removed for this SSH entry.");
      })
      .catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  };

  const removeSshEntry = () => {
    const workspace = managedSessions.find((item) => item.id === workspaceSessionId);
    if (!workspace || !sshEntryDraftId) return;
    const entry = workspace.sshEntries.find((item) => item.id === sshEntryDraftId);
    if (!entry || !window.confirm(`Remove SSH entry "${entry.name}"?`)) return;
    setManagedSessions((current) => current.map((item) => item.id !== workspace.id ? item : { ...item, sshEntries: item.sshEntries.filter((candidate) => candidate.id !== entry.id) }));
    setSshProfiles((current) => current.filter((item) => item.id !== entry.id));
    void invoke("ssh_forget_password", { entryId: entry.id }).catch(() => {});
    startNewSshEntry();
    setSshEntryDialogOpen(false);
  };

  // Direct removal (no Edit dialog required) used by the Sessions/Workspace
  // Manager's inline per-entry Remove buttons -- see T-217. Mirrors the
  // cleanup performed by removeSshEntry above, but is parameterized so it
  // can run without any dialog/draft state being open.
  const removeSshEntryDirect = (workspaceId: string, entry: SshProfile) => {
    if (!window.confirm(`Remove SSH entry "${entry.name}"?`)) return;
    setManagedSessions((current) => current.map((item) => item.id !== workspaceId ? item : { ...item, sshEntries: item.sshEntries.filter((candidate) => candidate.id !== entry.id) }));
    setSshProfiles((current) => current.filter((item) => item.id !== entry.id));
    void invoke("ssh_forget_password", { entryId: entry.id }).catch(() => {});
    if (sshEntryDraftId === entry.id) {
      startNewSshEntry();
      setSshEntryDialogOpen(false);
    }
    notify(`Removed SSH entry: ${entry.name}`);
  };

  // REST API and Proxmox VNC entries follow the exact same add/edit/remove
  // shape as SSH above: the dialog lives here, keyed to whichever Workspace
  // card it was opened from (setWorkspaceSessionId right before opening).
  // RestApiWorkspace/ProxmoxVncWorkspace's own sidebar only lists and
  // selects entries -- it has no add/edit UI of its own, same as the SSH
  // terminal panel's sidebar.
  const emptyRestEntry = (): RestApiEntry => ({
    id: crypto.randomUUID(),
    name: "New REST API",
    baseUrl: "",
    defaultPath: "/rest/v1",
    query: [],
    ignoreTlsErrors: false,
    authMode: "none",
    vendor: "none",
    username: "",
    loginPath: "/auth/login",
    loginMethod: "POST",
    loginBody: '{"username":"{{username}}","password":"{{password}}"}',
    tokenPath: "data.token",
    tokenHeader: "X-Auth-Token",
    tokenSendAs: "X-Auth-Token",
  });

  const openAddRestEntryDialog = (workspaceId: string) => {
    setWorkspaceSessionId(workspaceId);
    setRestEntryDraft(emptyRestEntry());
    setSessionFormError("");
    setRestEntryDialogOpen(true);
  };

  const openEditRestEntryDialog = (workspaceId: string, entry: RestApiEntry) => {
    setWorkspaceSessionId(workspaceId);
    setRestEntryDraft(entry);
    setSessionFormError("");
    setRestEntryDialogOpen(true);
  };

  const isEditingRestEntry = (workspace: ManagedSession | undefined, draft: RestApiEntry | null) =>
    Boolean(workspace && draft && workspace.restApiEntries.some((item) => item.id === draft.id));

  const saveRestEntry = () => {
    const workspace = managedSessions.find((item) => item.id === workspaceSessionId);
    const draft = restEntryDraft;
    if (!workspace) {
      setSessionFormError("Save the Workspace name first, then add a REST API entry to it.");
      return;
    }
    if (!draft || !draft.name.trim() || !draft.baseUrl.trim()) {
      setSessionFormError("Connection name and base URL are required.");
      return;
    }
    const wasEditing = isEditingRestEntry(workspace, draft);
    setManagedSessions((current) => current.map((item) => item.id !== workspace.id ? item : {
      ...item,
      restApiEntries: wasEditing
        ? item.restApiEntries.map((candidate) => candidate.id === draft.id ? draft : candidate)
        : [...item.restApiEntries, draft],
    }));
    setActiveRestEntryId(draft.id);
    setRestEntryDraft(null);
    setSessionFormError("");
    setRestEntryDialogOpen(false);
    notify(`${wasEditing ? "Updated" : "Added"} REST API entry: ${draft.name}`);
  };

  const removeRestEntry = () => {
    const workspace = managedSessions.find((item) => item.id === workspaceSessionId);
    const draft = restEntryDraft;
    if (!workspace || !draft || !isEditingRestEntry(workspace, draft)) return;
    if (!window.confirm(`Remove REST API entry "${draft.name}"?`)) return;
    setManagedSessions((current) => current.map((item) => item.id !== workspace.id ? item : { ...item, restApiEntries: item.restApiEntries.filter((candidate) => candidate.id !== draft.id) }));
    localStorage.removeItem(`rest-api-history:${draft.id}`);
    setRestEntryDraft(null);
    setRestEntryDialogOpen(false);
  };

  // Direct removal (no Edit dialog required) -- see T-217/T-218. Mirrors the
  // cleanup performed by removeRestEntry above, but is parameterized so it
  // can be triggered from the Sessions modal's inline Remove button or the
  // REST API sidebar's own Remove button without first opening the Edit
  // dialog.
  const removeRestEntryDirect = (workspaceId: string, entry: RestApiEntry) => {
    if (!window.confirm(`Remove REST API entry "${entry.name}"?`)) return;
    setManagedSessions((current) => current.map((item) => item.id !== workspaceId ? item : { ...item, restApiEntries: item.restApiEntries.filter((candidate) => candidate.id !== entry.id) }));
    localStorage.removeItem(`rest-api-history:${entry.id}`);
    if (restEntryDraft?.id === entry.id) {
      setRestEntryDraft(null);
      setRestEntryDialogOpen(false);
    }
    if (activeRestEntryId === entry.id) setActiveRestEntryId("");
    notify(`Removed REST API entry: ${entry.name}`);
  };

  const emptyVncEntry = (): ProxmoxVncEntry => ({
    id: crypto.randomUUID(),
    name: "New Proxmox VNC",
    baseUrl: "https://:8006",
    username: "root@pam",
    node: "",
    vmid: null,
    guestType: "qemu",
    proxmoxVersion: "auto",
    ignoreTlsErrors: false,
    vmSshUsername: "root",
    vmSshPort: 22,
    vmSshPrivateKeyPath: "",
    hostSshUsername: "root",
    hostSshPort: 22,
    hostSshPrivateKeyPath: "",
    fileTransferIpOverride: "",
  });

  const openAddVncEntryDialog = (workspaceId: string) => {
    setWorkspaceSessionId(workspaceId);
    setVncEntryDraft(emptyVncEntry());
    setVmSshPasswordDraft("");
    setVmSshPasswordSaved(false);
    setHostSshPasswordDraft("");
    setHostSshPasswordSaved(false);
    setSessionFormError("");
    setVncEntryModalTab("default");
    setVncEntryDialogOpen(true);
  };

  const openEditVncEntryDialog = (workspaceId: string, entry: ProxmoxVncEntry) => {
    setWorkspaceSessionId(workspaceId);
    setVncEntryDraft(entry);
    setVmSshPasswordDraft("");
    setHostSshPasswordDraft("");
    setVmSshPasswordSaved(false);
    setHostSshPasswordSaved(false);
    void invoke<boolean>("ssh_has_password", { entryId: vmSshProfileId(entry.id) }).then(setVmSshPasswordSaved).catch(() => setVmSshPasswordSaved(false));
    void invoke<boolean>("ssh_has_password", { entryId: hostSshProfileId(entry.id) }).then(setHostSshPasswordSaved).catch(() => setHostSshPasswordSaved(false));
    setSessionFormError("");
    setVncEntryModalTab("default");
    setVncEntryDialogOpen(true);
  };

  const isEditingVncEntry = (workspace: ManagedSession | undefined, draft: ProxmoxVncEntry | null) =>
    Boolean(workspace && draft && workspace.proxmoxVncEntries.some((item) => item.id === draft.id));

  const vncEndpointParts = (baseUrl: string) => {
    const match = baseUrl.match(/^https:\/\/(\[[0-9a-fA-F:]*\]|[^/:]*)(?::(\d*))?/i);
    return { host: match?.[1] ?? "", port: match?.[2] ?? "" };
  };
  const vncUsernameParts = (username: string) => {
    const [account = "root", realm = "pam"] = username.split("@", 2);
    return { account, realm: realm === "pve" ? "pve" : "pam" };
  };

  const saveVncEntry = () => {
    const workspace = managedSessions.find((item) => item.id === workspaceSessionId);
    const draft = vncEntryDraft;
    const endpoint = draft ? vncEndpointParts(draft.baseUrl) : null;
    const port = endpoint ? Number(endpoint.port) : 0;
    const username = draft ? vncUsernameParts(draft.username) : null;
    if (!workspace) {
      setSessionFormError("Save the Workspace name first, then add a Proxmox VNC entry to it.");
      return;
    }
    if (!draft || !draft.name.trim() || !endpoint?.host || !port || port < 1 || port > 65535 || !username?.account.trim()) {
      setSessionFormError("Connection name, Proxmox host, and a valid port are required.");
      return;
    }
    const wasEditing = isEditingVncEntry(workspace, draft);
    setManagedSessions((current) => current.map((item) => item.id !== workspace.id ? item : {
      ...item,
      proxmoxVncEntries: wasEditing
        ? item.proxmoxVncEntries.map((candidate) => candidate.id === draft.id ? draft : candidate)
        : [...item.proxmoxVncEntries, draft],
    }));
    setActiveVncEntryId(draft.id);
    if (vmSshPasswordDraft) {
      void invoke("ssh_save_password", { entryId: vmSshProfileId(draft.id), password: vmSshPasswordDraft })
        .then(() => setVmSshPasswordSaved(true))
        .catch((saveError) => setNotice(saveError instanceof Error ? saveError.message : String(saveError)));
    }
    if (hostSshPasswordDraft) {
      void invoke("ssh_save_password", { entryId: hostSshProfileId(draft.id), password: hostSshPasswordDraft })
        .then(() => setHostSshPasswordSaved(true))
        .catch((saveError) => setNotice(saveError instanceof Error ? saveError.message : String(saveError)));
    }
    setVmSshPasswordDraft("");
    setHostSshPasswordDraft("");
    setVncEntryDraft(null);
    setSessionFormError("");
    setVncEntryDialogOpen(false);
    notify(`${wasEditing ? "Updated" : "Added"} Proxmox VNC entry: ${draft.name}`);
  };

  const removeVncEntry = () => {
    const workspace = managedSessions.find((item) => item.id === workspaceSessionId);
    const draft = vncEntryDraft;
    if (!workspace || !draft || !isEditingVncEntry(workspace, draft)) return;
    if (!window.confirm(`Remove Proxmox VNC entry "${draft.name}"?`)) return;
    setManagedSessions((current) => current.map((item) => item.id !== workspace.id ? item : { ...item, proxmoxVncEntries: item.proxmoxVncEntries.filter((candidate) => candidate.id !== draft.id) }));
    void invoke("proxmox_forget_secret", { entryId: draft.id, kind: "password" }).catch(() => {});
    void invoke("ssh_forget_password", { entryId: vmSshProfileId(draft.id) }).catch(() => {});
    void invoke("ssh_forget_password", { entryId: hostSshProfileId(draft.id) }).catch(() => {});
    setVncEntryDraft(null);
    setVncEntryDialogOpen(false);
  };

  // Direct removal (no Edit dialog required) -- see T-217/T-218. Mirrors the
  // cleanup performed by removeVncEntry above, but is parameterized so it
  // can be triggered from the Sessions modal's inline Remove button or the
  // Proxmox VNC sidebar's own Remove button without first opening the Edit
  // dialog.
  const removeVncEntryDirect = (workspaceId: string, entry: ProxmoxVncEntry) => {
    if (!window.confirm(`Remove Proxmox VNC entry "${entry.name}"?`)) return;
    setManagedSessions((current) => current.map((item) => item.id !== workspaceId ? item : { ...item, proxmoxVncEntries: item.proxmoxVncEntries.filter((candidate) => candidate.id !== entry.id) }));
    void invoke("proxmox_forget_secret", { entryId: entry.id, kind: "password" }).catch(() => {});
    void invoke("ssh_forget_password", { entryId: vmSshProfileId(entry.id) }).catch(() => {});
    void invoke("ssh_forget_password", { entryId: hostSshProfileId(entry.id) }).catch(() => {});
    if (vncEntryDraft?.id === entry.id) {
      setVncEntryDraft(null);
      setVncEntryDialogOpen(false);
    }
    if (activeVncEntryId === entry.id) setActiveVncEntryId("");
    notify(`Removed Proxmox VNC entry: ${entry.name}`);
  };

  // Pushes the app's managed public key (see ssh_storage_dir on the Rust
  // side -- the same "<install dir>/.ssh" or "%USERPROFILE%\.ssh" location
  // every Terminal SSH entry's key lives in) onto the VM's or the Proxmox
  // host's own `~/.ssh/authorized_keys`, reusing the exact same
  // ssh_install_key command a regular SSH entry's "Install SSH key" button
  // uses -- it takes a generic SshProfile, so this needs no backend
  // changes. Requires that profile's password to already be saved (typed
  // into the field just above and Saved at least once), since key
  // installation authenticates with the stored password.
  const installVncSshKey = async (kind: "vm" | "host") => {
    const draft = vncEntryDraft;
    if (!draft) return;
    const isVm = kind === "vm";
    const host = isVm ? draft.fileTransferIpOverride?.trim() : proxmoxHostFromBaseUrl(draft.baseUrl);
    if (!host) {
      setSessionFormError(isVm
        ? "Enter the VM's IP in \"Fallback VM IP\" above first, then Save, before installing a key onto it."
        : "The Proxmox host field above must have a valid host before installing a key onto it.");
      return;
    }
    const profileId = isVm ? vmSshProfileId(draft.id) : hostSshProfileId(draft.id);
    const username = (isVm ? draft.vmSshUsername : draft.hostSshUsername)?.trim() || "root";
    const port = (isVm ? draft.vmSshPort : draft.hostSshPort) || 22;
    const passwordDraft = isVm ? vmSshPasswordDraft : hostSshPasswordDraft;
    const alreadySaved = isVm ? vmSshPasswordSaved : hostSshPasswordSaved;
    try {
      if (passwordDraft) {
        await invoke("ssh_save_password", { entryId: profileId, password: passwordDraft });
        if (isVm) setVmSshPasswordSaved(true); else setHostSshPasswordSaved(true);
      } else if (!alreadySaved) {
        setSessionFormError(`Enter and Save a ${isVm ? "VM SSH" : "Host SSH"} password above before installing a key with it.`);
        return;
      }
      const message = await invoke<string>("ssh_install_key", {
        profile: { id: profileId, name: `${draft.name} (${isVm ? "VM" : "host"} SSH)`, host, port, username, privateKeyPath: (isVm ? draft.vmSshPrivateKeyPath : draft.hostSshPrivateKeyPath) || null },
      });
      notify(message);
    } catch (installError) {
      setSessionFormError(installError instanceof Error ? installError.message : String(installError));
    }
  };

  const selectRestWorkspace = (id: string) => {
    selectWorkspaceSession(id);
    const workspace = managedSessions.find((item) => item.id === id);
    if (workspace?.restApiEntries[0]) setActiveRestEntryId(workspace.restApiEntries[0].id);
  };

  const selectVncWorkspace = (id: string) => {
    selectWorkspaceSession(id);
    const workspace = managedSessions.find((item) => item.id === id);
    if (workspace?.proxmoxVncEntries[0]) setActiveVncEntryId(workspace.proxmoxVncEntries[0].id);
  };

  const workspaceSessions = managedSessions.filter((item) => item.sshEntries.length > 0);
  const activeWorkspaceSession = workspaceSessions.find((item) => item.id === workspaceSessionId);
  // The Sessions modal's Workspace panel shows this regardless of whether it
  // has any SSH entries yet (unlike `activeWorkspaceSession` above, which is
  // scoped to the SSH terminal selector and only considers workspaces that
  // already have at least one SSH entry).
  const activeManagedWorkspace = managedSessions.find((item) => item.id === workspaceSessionId);
  const restWorkspace = activeManagedWorkspace || managedSessions.find((item) => item.restApiEntries.length) || managedSessions[0];
  const vncWorkspace = activeManagedWorkspace || managedSessions.find((item) => item.proxmoxVncEntries.length) || managedSessions[0];

  // Returns the current REST/VNC Workspace's id, creating a "Default"
  // Workspace on the fly (same fallback RestApiWorkspace/ProxmoxVncWorkspace
  // already use in onChangeEntries below) when none exists yet -- lets the
  // REST API/VNC sidebar's own "Add" button work even before any Workspace
  // has been created via the Sessions/Workspace Manager. See T-218.
  const ensureRestWorkspaceId = () => {
    if (restWorkspace) return restWorkspace.id;
    const id = crypto.randomUUID();
    setManagedSessions((current) => [...current, { id, name: "Default", sshEntries: [], restApiEntries: [], proxmoxVncEntries: [] }]);
    setWorkspaceSessionId(id);
    return id;
  };
  const ensureVncWorkspaceId = () => {
    if (vncWorkspace) return vncWorkspace.id;
    const id = crypto.randomUUID();
    setManagedSessions((current) => [...current, { id, name: "Default", sshEntries: [], restApiEntries: [], proxmoxVncEntries: [] }]);
    setWorkspaceSessionId(id);
    return id;
  };

  return {
    saveWorkspaceName,
    openWorkspaceNameDialog,
    removeSession,
    loadSshProfileDraft,
    selectWorkspaceSession,
    openSessionsModal,
    startNewWorkspace,
    startNewSshEntry,
    openAddSshEntryDialog,
    openEditSshEntryDialog,
    saveSshEntry,
    forgetSshPassword,
    removeSshEntry,
    removeSshEntryDirect,
    emptyRestEntry,
    openAddRestEntryDialog,
    openEditRestEntryDialog,
    isEditingRestEntry,
    saveRestEntry,
    removeRestEntry,
    removeRestEntryDirect,
    emptyVncEntry,
    openAddVncEntryDialog,
    openEditVncEntryDialog,
    isEditingVncEntry,
    vncEndpointParts,
    vncUsernameParts,
    saveVncEntry,
    removeVncEntry,
    removeVncEntryDirect,
    installVncSshKey,
    selectRestWorkspace,
    selectVncWorkspace,
    workspaceSessions,
    activeWorkspaceSession,
    activeManagedWorkspace,
    restWorkspace,
    vncWorkspace,
    ensureRestWorkspaceId,
    ensureVncWorkspaceId,
  };
}

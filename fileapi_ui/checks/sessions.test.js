import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript, hookDriver } from "./test-utils.js";

const makeActions = (invoke, initial = {}) => {
  const hooks = hookDriver({ effects: false });
  const calls = [];
  const state = {
    managedSessions: [{ id: "workspace", name: "Workspace", sshEntries: [], restApiEntries: [], proxmoxVncEntries: [] }],
    workspaceSessionId: "workspace",
    draft: { id: "", name: "Server", host: "host", port: "22", username: "user", privateKeyPath: "", password: "secret" },
    saving: [],
    errors: [],
    notices: [],
    dialog: [],
    vncDraft: null,
    vncPasswordDraft: "",
    vncPasswordSaved: false,
    vncPasswordSaving: false,
    activeVncEntryId: "",
    ...initial,
  };
  const setManagedSessions = (update) => {
    state.managedSessions = typeof update === "function" ? update(state.managedSessions) : update;
  };
  const setDraft = (update) => {
    state.draft = typeof update === "function" ? update(state.draft) : update;
  };
  const { useSessionsActions } = loadTypeScript("features/sessions/useSessionsActions.ts", {
    mocks: {
      react: { useRef: (current) => ({ current }) },
      "@tauri-apps/api/core": { invoke: async (...args) => { calls.push(args); return invoke(...args); } },
      "../../proxmox-vnc": { hostSshProfileId: (entryId) => `vncjump:${entryId}`, proxmoxHostFromBaseUrl: () => "host" },
      "../terminal/terminal-utils": { makeSshTabId: () => "new-entry" },
    },
    globals: { React: {} },
  });
  const actions = useSessionsActions({
    run: (action) => action(),
    notify() {},
    setNotice: (message) => state.notices.push(message),
    managedSessions: state.managedSessions,
    setManagedSessions,
    workspaceSessionId: state.workspaceSessionId,
    setWorkspaceSessionId() {},
    sessionNameDraft: "",
    setSessionNameDraft() {},
    setSessionFormError: (message) => state.errors.push(message),
    setLastSavedSessionId() {},
    setWorkspaceNameDialogOpen() {},
    setSessionsOpen() {},
    sshProfiles: [],
    setSshProfiles() {},
    sshProfileId: "",
    setSshProfileId() {},
    selectedSshEntryId: "",
    setSelectedSshEntryId() {},
    sshProfileDraft: state.draft,
    setSshProfileDraft: setDraft,
    setSshPasswordSaved() {},
    setSshEntrySaving: (saving) => state.saving.push(saving),
    sshEntryDraftId: "",
    setSshEntryDraftId() {},
    setSshEntryDialogOpen: (open) => state.dialog.push(open),
    restEntryDraft: null,
    setRestEntryDraft() {},
    setRestEntryDialogOpen() {},
    activeRestEntryId: "",
    setActiveRestEntryId() {},
    vncEntryDraft: state.vncDraft,
    setVncEntryDraft(value) { state.vncDraft = value; },
    setVncEntryDialogOpen(value) { state.dialog.push(value); },
    setVncEntryModalTab() {},
    vncEntryPasswordDraft: state.vncPasswordDraft,
    setVncEntryPasswordDraft(value) { state.vncPasswordDraft = value; },
    vncEntryPasswordSaved: state.vncPasswordSaved,
    setVncEntryPasswordSaved(value) { state.vncPasswordSaved = value; },
    setVncEntryPasswordSaving(value) { state.vncPasswordSaving = value; },
    activeVncEntryId: state.activeVncEntryId,
    setActiveVncEntryId(value) { state.activeVncEntryId = value; },
    hostSshPasswordDraft: "",
    setHostSshPasswordDraft() {},
    hostSshPasswordSaved: false,
    setHostSshPasswordSaved() {},
    onVncEntrySaved: (entryId) => { state.savedVncEntryId = entryId; },
  });
  return { actions, state, calls };
};

test("SSH Entry save commits the entry only after the password is stored", async () => {
  const harness = makeActions(async () => undefined);
  await harness.actions.saveSshEntry();
  assert.equal(harness.calls[0][0], "ssh_save_password");
  assert.equal(harness.state.managedSessions[0].sshEntries[0].id, "new-entry");
  assert.deepEqual(harness.state.dialog, [false]);
  assert.deepEqual(harness.state.saving, [true, false]);
});

test("Proxmox password is stored through the credential API and omitted from Workspace data", async () => {
  const entry = { id: "pve", name: "PVE", baseUrl: "https://pve.local:8006", username: "root@pam", node: "node", vmid: null, guestType: "qemu", proxmoxVersion: "auto", ignoreTlsErrors: false };
  const harness = makeActions(async () => undefined, {
    managedSessions: [{ id: "workspace", name: "Workspace", sshEntries: [], restApiEntries: [], proxmoxVncEntries: [entry] }],
    vncDraft: entry,
    vncPasswordDraft: "secret-value",
  });
  await harness.actions.saveVncEntry();
  assert.deepEqual(harness.calls[0], ["proxmox_save_secret", { entryId: "pve", kind: "password", value: "secret-value" }]);
  assert.equal(harness.state.managedSessions[0].proxmoxVncEntries[0].password, undefined);
  assert.doesNotMatch(JSON.stringify(harness.state.managedSessions), /secret-value/);
  assert.equal(harness.state.savedVncEntryId, "pve");
  assert.equal(harness.state.vncPasswordDraft, "");
});

test("Proxmox password-store errors keep the Workspace Entry dialog open", async () => {
  const entry = { id: "pve", name: "PVE", baseUrl: "https://pve.local:8006", username: "root@pam", node: "node", vmid: null, guestType: "qemu", proxmoxVersion: "auto", ignoreTlsErrors: false };
  const harness = makeActions(async (command) => {
    if (command === "proxmox_save_secret") throw new Error("credential store unavailable");
  }, {
    managedSessions: [{ id: "workspace", name: "Workspace", sshEntries: [], restApiEntries: [], proxmoxVncEntries: [entry] }],
    vncDraft: entry,
    vncPasswordDraft: "secret-value",
  });
  await harness.actions.saveVncEntry();
  assert.equal(harness.state.managedSessions[0].proxmoxVncEntries.length, 1);
  assert.deepEqual(harness.state.dialog, []);
  assert.match(harness.state.errors.find(Boolean), /Unable to save the Proxmox password/);
});

test("the automatic-login Workspace form cannot continue without a saved password", async () => {
  const entry = { id: "pve", name: "PVE", baseUrl: "https://pve.local:8006", username: "root@pam", node: "node", vmid: null, guestType: "qemu", proxmoxVersion: "auto", ignoreTlsErrors: false };
  const harness = makeActions(async () => undefined, {
    managedSessions: [{ id: "workspace", name: "Workspace", sshEntries: [], restApiEntries: [], proxmoxVncEntries: [entry] }],
    vncDraft: entry,
  });
  await harness.actions.saveVncEntry(true);
  assert.match(harness.state.errors.find(Boolean), /password is required to connect/);
  assert.equal(harness.state.dialog.length, 0, "the edit form stays open");
  assert.equal(harness.calls.length, 0);
});

test("the automatic login resumes only after the credential store confirms persistence", async () => {
  const entry = { id: "pve", name: "PVE", baseUrl: "https://pve.local:8006", username: "root@pam", node: "node", vmid: null, guestType: "qemu", proxmoxVersion: "auto", ignoreTlsErrors: false };
  let resolveSave;
  const saveResult = new Promise((resolve) => { resolveSave = resolve; });
  const harness = makeActions(async (command) => command === "proxmox_save_secret" ? saveResult : undefined, {
    managedSessions: [{ id: "workspace", name: "Workspace", sshEntries: [], restApiEntries: [], proxmoxVncEntries: [entry] }],
    vncDraft: entry,
    vncPasswordDraft: "new-secret",
  });
  const saving = harness.actions.saveVncEntry(true);
  for (let attempt = 0; attempt < 3; attempt += 1) await Promise.resolve();
  assert.equal(harness.state.savedVncEntryId, undefined, "login continuation waits for the credential write");
  resolveSave();
  await saving;
  assert.equal(harness.state.savedVncEntryId, "pve");
});

test("editing a Proxmox entry checks the credential store without putting its secret in the draft", async () => {
  const entry = { id: "pve", name: "PVE", baseUrl: "https://pve.local:8006", username: "root@pam", node: "node", vmid: null, guestType: "qemu", proxmoxVersion: "auto", ignoreTlsErrors: false };
  const harness = makeActions(async (command) => command === "proxmox_load_secret" ? "saved-password" : undefined);
  harness.actions.openEditVncEntryDialog("workspace", entry);
  for (let attempt = 0; attempt < 4; attempt += 1) await Promise.resolve();
  assert.equal(harness.state.vncPasswordSaved, true);
  assert.equal(harness.state.vncPasswordDraft, "");
  assert.equal(JSON.stringify(harness.state.vncDraft).includes("saved-password"), false);
});

test("forgetting a Proxmox password deletes only its keyring record", async () => {
  const entry = { id: "pve", name: "PVE", baseUrl: "https://pve.local:8006", username: "root@pam", node: "node", vmid: null, guestType: "qemu", proxmoxVersion: "auto", ignoreTlsErrors: false };
  const harness = makeActions(async () => undefined, { vncDraft: entry, vncPasswordSaved: true });
  await harness.actions.forgetVncPassword();
  assert.deepEqual(harness.calls[0], ["proxmox_forget_secret", { entryId: "pve", kind: "password" }]);
  assert.equal(harness.state.vncPasswordSaved, false);
  assert.equal(JSON.stringify(harness.state.managedSessions).includes("password"), false);
});

test("SSH Entry save keeps the draft open when the password store rejects", async () => {
  const harness = makeActions(async () => { throw new Error("credential store unavailable"); });
  await harness.actions.saveSshEntry();
  assert.equal(harness.state.managedSessions[0].sshEntries.length, 0);
  assert.deepEqual(harness.state.dialog, []);
  assert.deepEqual(harness.state.saving, [true, false]);
  assert.match(harness.state.errors[0], /Unable to save the SSH password/);
});

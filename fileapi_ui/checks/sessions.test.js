import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript, hookDriver } from "./test-utils.js";

const makeActions = (invoke) => {
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
  };
  const setManagedSessions = (update) => {
    state.managedSessions = typeof update === "function" ? update(state.managedSessions) : update;
  };
  const setDraft = (update) => {
    state.draft = typeof update === "function" ? update(state.draft) : update;
  };
  const { useSessionsActions } = loadTypeScript("features/sessions/useSessionsActions.ts", {
    mocks: {
      "@tauri-apps/api/core": { invoke: async (...args) => { calls.push(args); return invoke(...args); } },
      "../../proxmox-vnc": {},
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
    vncEntryDraft: null,
    setVncEntryDraft() {},
    setVncEntryDialogOpen() {},
    setVncEntryModalTab() {},
    activeVncEntryId: "",
    setActiveVncEntryId() {},
    hostSshPasswordDraft: "",
    setHostSshPasswordDraft() {},
    hostSshPasswordSaved: false,
    setHostSshPasswordSaved() {},
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

test("SSH Entry save keeps the draft open when the password store rejects", async () => {
  const harness = makeActions(async () => { throw new Error("credential store unavailable"); });
  await harness.actions.saveSshEntry();
  assert.equal(harness.state.managedSessions[0].sshEntries.length, 0);
  assert.deepEqual(harness.state.dialog, []);
  assert.deepEqual(harness.state.saving, [true, false]);
  assert.match(harness.state.errors[0], /Unable to save the SSH password/);
});

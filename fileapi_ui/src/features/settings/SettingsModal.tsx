import React from "react";
import { FloatingWindow } from "../../ui/FloatingWindow";
import { Dropdown } from "../../ui/Dropdown";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, WarningIcon } from "../../ui/icons";
import { accentCollidesWithSemanticColor, themePresets, type ThemePreset } from "../../styles/theme";
import { formatSize } from "../../format-utils";
import { defaultDesktopSettings, type DesktopSettings, type OperationStorageInfo, type SettingsPanel } from "./settings-contracts";

type SettingsModalProps = {
  desktopSettings: DesktopSettings;
  setDesktopSettings: React.Dispatch<React.SetStateAction<DesktopSettings>>;
  settingsPanel: SettingsPanel | null;
  setSettingsPanel: React.Dispatch<React.SetStateAction<SettingsPanel | null>>;
  themeSnapshot: { theme: ThemePreset; accentColor: string } | null;
  storageInfo: OperationStorageInfo | null;
  modalStyle: React.CSSProperties;
  onDragStart: (event: React.MouseEvent<HTMLElement>) => void;
  onClose: () => void;
  onSave: () => void;
  onManageShareLinks: () => void;
  canManageShareLinks: boolean;
  onClearHistory: () => void;
  onClearLogs: () => void;
};

export function SettingsModal({
  desktopSettings,
  setDesktopSettings,
  settingsPanel,
  setSettingsPanel,
  themeSnapshot,
  storageInfo,
  modalStyle,
  onDragStart,
  onClose,
  onSave,
  onManageShareLinks,
  canManageShareLinks,
  onClearHistory,
  onClearLogs,
}: SettingsModalProps) {
  return (
    <FloatingWindow
      ariaLabel="Desktop Settings"
      className={`settings-modal settings-panel-${settingsPanel || "menu"}`}
      style={modalStyle}
      onClose={onClose}
      onDragStart={onDragStart}
      header={(
        <div className="settings-floating-heading">
          <h2 className="modal-drag-handle">Desktop Settings</h2>
          <button type="button" className="settings-floating-close" onClick={onClose} aria-label="Close Desktop Settings">
            <CloseIcon />
          </button>
        </div>
      )}
      footer={(
        <div className="settings-floating-footer">
          <button type="button" className="confirm" onClick={onSave}>Save</button>
          <button type="button" onClick={() => (settingsPanel === null ? onClose() : setSettingsPanel(null))}>Close</button>
        </div>
      )}
    >
      <p className="settings-intro">Safe defaults keep confirmations and security checks enabled. These preferences can hide prompts only; they never bypass permissions, read-only rules, path boundaries, destination validation, or transfer verification.</p>
      {settingsPanel !== null && <button type="button" className="settings-subpanel-back" onClick={() => setSettingsPanel(null)}><ChevronLeftIcon size={12} /> Settings</button>}
      {settingsPanel === null && (
        <div className="settings-panel-menu">
          <button type="button" className="settings-panel-card" onClick={() => setSettingsPanel("theme")}>
            <strong>Color theme</strong><span>{themePresets[desktopSettings.theme].label}</span><small>Choose colors and visual effects.</small><b><ChevronRightIcon size={12} /></b>
          </button>
          <button type="button" className="settings-panel-card" onClick={() => setSettingsPanel("features")}>
            <strong>Interface features</strong>
            <span>{[desktopSettings.restApiModeEnabled ? "REST API enabled" : "REST API disabled", desktopSettings.proxmoxVncModeEnabled ? "Proxmox VNC enabled" : "Proxmox VNC disabled"].join(" · ")}</span>
            <small>Enable optional workspaces.</small><b><ChevronRightIcon size={12} /></b>
          </button>
          <button type="button" className="settings-panel-card" onClick={() => setSettingsPanel("confirmations")}>
            <strong>Risk confirmations</strong><span>Safety prompts</span><small>Choose destructive-action confirmations.</small><b><ChevronRightIcon size={12} /></b>
          </button>
          <button type="button" className="settings-panel-card" onClick={() => setSettingsPanel("sharing")}>
            <strong>Sharing</strong><span>{desktopSettings.shareLinkMode === "secure" ? "Secure links" : "Direct links"}</span><small>Configure link defaults.</small><b><ChevronRightIcon size={12} /></b>
          </button>
          <button type="button" className="settings-panel-card" onClick={() => setSettingsPanel("history")}>
            <strong>History and operation log</strong><span>{desktopSettings.operationLogEnabled ? "Enabled" : "Disabled"}</span><small>Configure history and logs.</small><b><ChevronRightIcon size={12} /></b>
          </button>
        </div>
      )}
      <section className="settings-section">
        <h3>Color theme</h3>
        <div className="settings-check settings-theme-row">
          <span><strong>Application palette</strong><small>Changes the shared colors used by the main view, overlays, buttons, and status states. Selecting a theme previews it immediately; use Revert below to go back to what was active before you opened Settings.</small></span>
          <Dropdown
            label="Application palette"
            value={desktopSettings.theme}
            onChange={(value) => { const theme = value as ThemePreset; setDesktopSettings((current) => ({ ...current, theme, accentColor: themePresets[theme].variables.cyan })); }}
            options={(Object.entries(themePresets) as [ThemePreset, { label: string }][]).map(([value, theme]) => ({ value, label: theme.label }))}
          />
          <label className="theme-accent-control">Accent <input type="color" value={desktopSettings.accentColor} onChange={(event) => setDesktopSettings((current) => ({ ...current, accentColor: event.target.value }))} /></label>
        </div>
        <div className="settings-appearance-options">
          <h4>Visual effects</h4>
          <label className="settings-check">
            <input type="checkbox" checked={desktopSettings.glassMainEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, glassMainEnabled: event.target.checked }))} />
            <span><strong>Main screen glass effect</strong><small>Keeps the soft see-through look on the main screen. Turn it off for smoother performance.</small></span>
          </label>
          <label className="settings-check">
            <input type="checkbox" checked={desktopSettings.glassMenusEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, glassMenusEnabled: event.target.checked }))} />
            <span><strong>Menu glass effect</strong><small>Keeps the soft see-through look on menus and lists. Turn it off to make menus lighter.</small></span>
          </label>
          <label className="settings-check">
            <input type="checkbox" checked={desktopSettings.glassDialogsEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, glassDialogsEnabled: event.target.checked }))} />
            <span><strong>Window glass effect</strong><small>Keeps the soft see-through look on settings and other pop-up windows.</small></span>
          </label>
        </div>
        {(() => {
          // T-216: only shown once the previewed theme/accent actually
          // diverges from the snapshot captured when Settings opened, so
          // Revert never appears as a no-op action.
          if (!themeSnapshot || (themeSnapshot.theme === desktopSettings.theme && themeSnapshot.accentColor === desktopSettings.accentColor)) return null;
          return (
            <button
              type="button"
              className="settings-theme-revert"
              onClick={() => setDesktopSettings((current) => ({ ...current, theme: themeSnapshot.theme, accentColor: themeSnapshot.accentColor }))}
            >
              Revert to {themePresets[themeSnapshot.theme].label}
            </button>
          );
        })()}
        {(() => {
          // T-214: warn (not block) when the chosen accent color is close
          // enough to the active theme's danger/warning color that
          // destructive-action styling (delete buttons, privileged/
          // danger drop-target highlighting) could become visually
          // ambiguous with the newly "selected"/focus-ring accent.
          const collision = accentCollidesWithSemanticColor(desktopSettings.theme, desktopSettings.accentColor);
          if (!collision.withDanger && !collision.withWarning) return null;
          const withLabel = [collision.withDanger && "danger", collision.withWarning && "warning"].filter(Boolean).join(" and ");
          return (
            <p className="settings-accent-warning" role="alert">
              <WarningIcon size={12} /> This accent color is close to this theme&apos;s {withLabel} color. Destructive-action buttons and status highlights may be harder to tell apart from the selected/focus accent.
            </p>
          );
        })()}
      </section>
      <section className="settings-section">
        <h3>Interface features</h3>
        <label className="settings-check">
          <input type="checkbox" checked={desktopSettings.restApiModeEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, restApiModeEnabled: event.target.checked }))} />
          <span><strong>Enable REST API mode</strong><small>Show the REST API workspace and its mode switcher.</small></span>
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={desktopSettings.proxmoxVncModeEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, proxmoxVncModeEnabled: event.target.checked }))} />
          <span><strong>Enable Proxmox VNC mode</strong><small>Show the Proxmox VNC workspace and its mode switcher.</small></span>
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={desktopSettings.collapseMainPaneEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, collapseMainPaneEnabled: event.target.checked }))} />
          <span><strong>Use collapse controls instead of split resizebars</strong><small>Apply the main collapse/restore pane controls globally in Location, REST API, and VNC. LOCAL's internal tree controls are unchanged.</small></span>
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={desktopSettings.bracketedPasteControlEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, bracketedPasteControlEnabled: event.target.checked }))} />
          <span><strong>Sanitize bracketed-paste markers</strong><small>Remove pasted bracketed-paste control markers from clipboard text before sending it to the remote terminal.</small></span>
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={desktopSettings.allowLegacySshAlgorithms} onChange={(event) => setDesktopSettings((current) => ({ ...current, allowLegacySshAlgorithms: event.target.checked }))} />
          <span><strong>Allow legacy SSH algorithms for older servers</strong><small>Lets the SSH terminal, SFTP browser, and key install fall back to older key exchange, cipher, and MAC algorithms (e.g. diffie-hellman-group14-sha1, aes-cbc, hmac-sha1) when a server is too old to speak anything stronger. Only enable this if you need to reach such a server -- it weakens the connection's cryptography.</small></span>
        </label>
      </section>
      <section className="settings-section">
        <h3>Risk confirmations</h3>
        {([
          ["delete", "Delete", "Deleting files or folders can permanently remove data."],
          ["overwrite", "Overwrite", "Replacing an existing destination can destroy its current contents."],
          ["recursive", "Recursive operations", "Applying an operation to a folder also affects its descendants."],
          ["crossSourceMove", "Cross-source move", "Moving between sources uses copy and verification before source deletion."],
        ] as const).map(([key, label, description]) => (
          <label className="settings-check" key={key}>
            <input
              type="checkbox"
              checked={desktopSettings.confirmations[key]}
              onChange={(event) => setDesktopSettings((current) => ({ ...current, confirmations: { ...current.confirmations, [key]: event.target.checked } }))}
            />
            <span><strong>{label}</strong><small>{description}</small></span>
          </label>
        ))}
        <button type="button" onClick={() => setDesktopSettings((current) => ({ ...current, confirmations: { ...defaultDesktopSettings.confirmations } }))}>Restore safe confirmations</button>
      </section>
      <section className="settings-section">
        <h3>Sharing</h3>
        <label className="settings-check">
          <input
            type="radio"
            name="shareLinkMode"
            checked={desktopSettings.shareLinkMode === "secure"}
            onChange={() => setDesktopSettings((current) => ({ ...current, shareLinkMode: "secure" }))}
          />
          <span><strong>Secure share (web page link)</strong><small>Opens the share.html page; supports an optional password. Use for sharing with people.</small></span>
        </label>
        <label className="settings-check">
          <input
            type="radio"
            name="shareLinkMode"
            checked={desktopSettings.shareLinkMode === "direct"}
            onChange={() => setDesktopSettings((current) => ({ ...current, shareLinkMode: "direct" }))}
          />
          <span><strong>Direct link (for tools like BMC)</strong><small>A plain file URL with no page and no Authorization header, for pasting into tools that only accept a bare link. No password protection.</small></span>
        </label>
        <label className="settings-level">Default share link expiration
          <Dropdown
            label="Default share link expiration"
            value={String(desktopSettings.shareLinkExpirationDays)}
            onChange={(value) => setDesktopSettings((current) => ({ ...current, shareLinkExpirationDays: Number(value) }))}
            options={[
              { value: "0", label: "Server default" },
              { value: "1", label: "1 day" },
              { value: "7", label: "7 days" },
              { value: "30", label: "30 days" },
              { value: "90", label: "90 days" },
            ]}
          />
          <small>Applied to every new share link created from this desktop app. The server also enforces its own configured maximum, so longer values may be rejected.</small>
        </label>
        <div className="settings-inline-action">
          <div><strong>Share link management</strong><small>Review, copy, or revoke links created by this desktop client.</small></div>
          <button type="button" onClick={onManageShareLinks} disabled={!canManageShareLinks}>Manage Share Links</button>
        </div>
      </section>
      <section className="settings-section">
        <h3>History and operation log</h3>
        <p>Both are enabled by default. Undo records are reserved for reliable, verifiable reversals. The operation log is append-only, excludes secrets, rotates at 10 MB, and retains at most three files total.</p>
        <label className="settings-check"><input type="checkbox" checked={desktopSettings.undoHistoryEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, undoHistoryEnabled: event.target.checked }))} /><span><strong>Enable undo history</strong><small>Disabling this stops new undo records; it does not delete files.</small></span></label>
        <label className="settings-check"><input type="checkbox" checked={desktopSettings.operationLogEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, operationLogEnabled: event.target.checked }))} /><span><strong>Enable operation log</strong><small>Disabling this stops new audit records; it does not delete unrelated data.</small></span></label>
        <label className="settings-level">Log detail level
          <Dropdown
            label="Log detail level"
            value={desktopSettings.operationLogLevel}
            onChange={(value) => setDesktopSettings((current) => ({ ...current, operationLogLevel: value as DesktopSettings["operationLogLevel"] }))}
            options={[
              { value: "DEBUG", label: "DEBUG - diagnostics and operations" },
              { value: "INFO", label: "INFO - normal operations" },
              { value: "WARN", label: "WARN - warnings and failures" },
              { value: "ERROR", label: "ERROR - failures only" },
            ]}
          />
          <small>DEBUG is enabled by default during development. Lower levels reduce diagnostic detail.</small>
        </label>
        {storageInfo && <div className="storage-info"><span>History: {storageInfo.historyPath} ({formatSize(storageInfo.historyBytes)})</span><span>Logs: {storageInfo.logPath} ({formatSize(storageInfo.logBytes)})</span><span>{storageInfo.logFiles.length} log file{storageInfo.logFiles.length === 1 ? "" : "s"} currently retained</span></div>}
        <div className="modal-actions settings-actions"><button type="button" onClick={onClearHistory}>Clear undo history</button><button type="button" className="danger" onClick={onClearLogs}>Clear operation logs</button></div>
      </section>
    </FloatingWindow>
  );
}

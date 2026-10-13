import { formatQuantity, useAppTranslation } from "../../i18n/useAppTranslation";
import React from "react";
import { FloatingWindow } from "../../ui/FloatingWindow";
import { Dropdown } from "../../ui/Dropdown";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, WarningIcon } from "../../ui/icons";
import { accentCollidesWithSemanticColor, themePresets, type ThemePreset } from "../../styles/theme";
import { formatSize } from "../../format-utils";
import { getAppLocale, toIntlLocale } from "../../i18n/i18n";
import { WallpaperSettings } from "../../pane/WallpaperSettings";
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
  const { t } = useAppTranslation();
  return (
    <FloatingWindow
      ariaLabel={t("Desktop Settings")}
      className={`settings-modal settings-panel-${settingsPanel || "menu"}`}
      style={modalStyle}
      onClose={onClose}
      onDragStart={onDragStart}
      header={(
        <div className="settings-floating-heading">
          <h2 className="modal-drag-handle">{t("Desktop Settings")}</h2>
          <button type="button" className="settings-floating-close" onClick={onClose} aria-label={t("Close Desktop Settings")}>
            <CloseIcon />
          </button>
        </div>
      )}
      footer={(
        <div className="settings-floating-footer">
          <button type="button" className="confirm" onClick={onSave}>{t("Save")}</button>
          <button type="button" onClick={() => (settingsPanel === null ? onClose() : setSettingsPanel(null))}>{t("Close")}</button>
        </div>
      )}
    >
      <p className="settings-intro">{t("Safe defaults keep confirmations and security checks enabled. These preferences can hide prompts only; they never bypass permissions, read-only rules, path boundaries, destination validation, or transfer verification.")}</p>
      {settingsPanel !== null && <button type="button" className="settings-subpanel-back" onClick={() => setSettingsPanel(null)}><ChevronLeftIcon size={12} /> {t("Settings")}</button>}
      {settingsPanel === null && (
        <div className="settings-panel-menu">
          <button type="button" className="settings-panel-card" onClick={() => setSettingsPanel("theme")}>
            <strong>{t("Color theme")}</strong><span>{t(themePresets[desktopSettings.theme].label)}</span><small>{t("Choose colors and visual effects.")}</small><b><ChevronRightIcon size={12} /></b>
          </button>
          <button type="button" className="settings-panel-card" onClick={() => setSettingsPanel("features")}>
            <strong>{t("Interface features")}</strong>
            <span>{[desktopSettings.restApiModeEnabled ? t("REST API enabled") : t("REST API disabled"), desktopSettings.proxmoxVncModeEnabled ? t("Proxmox VNC enabled") : t("Proxmox VNC disabled")].join(" · ")}</span>
            <small>{t("Enable optional workspaces.")}</small><b><ChevronRightIcon size={12} /></b>
          </button>
          <button type="button" className="settings-panel-card" onClick={() => setSettingsPanel("confirmations")}>
            <strong>{t("Risk confirmations")}</strong><span>{t("Safety prompts")}</span><small>{t("Choose destructive-action confirmations.")}</small><b><ChevronRightIcon size={12} /></b>
          </button>
          <button type="button" className="settings-panel-card" onClick={() => setSettingsPanel("sharing")}>
            <strong>{t("Sharing")}</strong><span>{desktopSettings.shareLinkMode === "secure" ? t("Secure links") : t("Direct links")}</span><small>{t("Configure link defaults.")}</small><b><ChevronRightIcon size={12} /></b>
          </button>
          <button type="button" className="settings-panel-card" onClick={() => setSettingsPanel("history")}>
            <strong>{t("History and operation log")}</strong><span>{desktopSettings.operationLogEnabled ? t("Enabled") : t("Disabled")}</span><small>{t("Configure history and logs.")}</small><b><ChevronRightIcon size={12} /></b>
          </button>
        </div>
      )}
      <section className="settings-section settings-section-theme">
        <h3>{t("Color theme")}</h3>
        <div className="settings-check settings-theme-row">
          <span><strong>{t("Application palette")}</strong><small>{t("Changes the shared colors used by the main view, overlays, buttons, and status states. Selecting a theme previews it immediately; use Revert below to go back to what was active before you opened Settings.")}</small></span>
          <Dropdown
            label={t("Application palette")}
            value={desktopSettings.theme}
            onChange={(value) => { const theme = value as ThemePreset; setDesktopSettings((current) => ({ ...current, theme, accentColor: themePresets[theme].variables.cyan })); }}
            options={(Object.entries(themePresets) as [ThemePreset, { label: string }][]).map(([value, theme]) => ({ value, label: t(theme.label) }))}
          />
          <label className="theme-accent-control">{t("Accent")} <input type="color" value={desktopSettings.accentColor} onChange={(event) => setDesktopSettings((current) => ({ ...current, accentColor: event.target.value }))} /></label>
        </div>
        <div className="settings-appearance-options">
          <h4>{t("Visual effects")}</h4>
          <label className="settings-check">
            <input type="checkbox" checked={desktopSettings.glassMainEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, glassMainEnabled: event.target.checked }))} />
            <span><strong>{t("Main screen glass effect")}</strong><small>{t("Keeps the soft see-through look on the main screen. Turn it off for smoother performance.")}</small></span>
          </label>
          <label className="settings-check">
            <input type="checkbox" checked={desktopSettings.glassMenusEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, glassMenusEnabled: event.target.checked }))} />
            <span><strong>{t("Menu glass effect")}</strong><small>{t("Keeps the soft see-through look on menus and lists. Turn it off to make menus lighter.")}</small></span>
          </label>
          <label className="settings-check">
            <input type="checkbox" checked={desktopSettings.glassDialogsEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, glassDialogsEnabled: event.target.checked }))} />
            <span><strong>{t("Window glass effect")}</strong><small>{t("Keeps the soft see-through look on settings and other pop-up windows.")}</small></span>
          </label>
          <label className="settings-check">
            <input type="checkbox" checked={desktopSettings.paneShadowEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, paneShadowEnabled: event.target.checked }))} />
            <span><strong>{t("Window shadows")}</strong><small>{t("Gives desktop windows a raised look with a shadow on the right and bottom. Turn it off to save graphics-card work.")}</small></span>
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
              {t("Revert to {{theme}}", { theme: t(themePresets[themeSnapshot.theme].label) })}
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
          const withLabel = [collision.withDanger && t("danger"), collision.withWarning && t("warning")].filter(Boolean).join(" and ");
          return (
            <p className="settings-accent-warning" role="alert">
              <WarningIcon size={12} /> {t("This accent color is close to this theme’s {{label}} color. Destructive-action buttons and status highlights may be harder to tell apart from the selected/focus accent.", { label: withLabel })}
            </p>
          );
        })()}
      </section>
      <WallpaperSettings />
      <section className="settings-section settings-section-features">
        <h3>{t("Interface features")}</h3>
        <label className="settings-check">
          <input type="checkbox" checked={desktopSettings.restApiModeEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, restApiModeEnabled: event.target.checked }))} />
          <span><strong>{t("Enable REST API mode")}</strong><small>{t("Show RestAPI in the Functions menu.")}</small></span>
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={desktopSettings.proxmoxVncModeEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, proxmoxVncModeEnabled: event.target.checked }))} />
          <span><strong>{t("Enable Proxmox VNC mode")}</strong><small>{t("Show VNC in the Functions menu.")}</small></span>
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={desktopSettings.collapseMainPaneEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, collapseMainPaneEnabled: event.target.checked }))} />
          <span><strong>{t("Use collapse controls instead of split resizebars")}</strong><small>{t("Apply collapse/restore controls to the Remote Folders pane and the RestAPI/VNC entry panes. LOCAL’s internal tree controls are unchanged.")}</small></span>
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={desktopSettings.bracketedPasteControlEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, bracketedPasteControlEnabled: event.target.checked }))} />
          <span><strong>{t("Sanitize bracketed-paste markers")}</strong><small>{t("Remove real bracketed-paste control markers and visible outer wrappers from clipboard text. Marker strings inside source code are kept. When off, real control markers block the paste. Unsafe control characters are always blocked. Pasting line breaks or tabs requires bracketed paste to be enabled by the remote application; this setting does not enable it or add Enter.")}</small></span>
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={desktopSettings.allowLegacySshAlgorithms} onChange={(event) => setDesktopSettings((current) => ({ ...current, allowLegacySshAlgorithms: event.target.checked }))} />
          <span><strong>{t("Allow legacy SSH algorithms for older servers")}</strong><small>{t("Lets the SSH terminal, SFTP browser, and key install fall back to older key exchange, cipher, and MAC algorithms (e.g. diffie-hellman-group14-sha1, aes-cbc, hmac-sha1) when a server is too old to speak anything stronger. Only enable this if you need to reach such a server — it weakens the connection’s cryptography.")}</small></span>
        </label>
      </section>
      <section className="settings-section settings-section-confirmations">
        <h3>{t("Risk confirmations")}</h3>
        {([
          ["delete", t("Delete"), t("Deleting files or folders can permanently remove data.")],
          ["overwrite", t("Overwrite"), t("Replacing an existing destination can destroy its current contents.")],
          ["recursive", t("Recursive operations"), t("Applying an operation to a folder also affects its descendants.")],
          ["crossSourceMove", t("Cross-source move"), t("Moving between sources uses copy and verification before source deletion.")],
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
        <button type="button" onClick={() => setDesktopSettings((current) => ({ ...current, confirmations: { ...defaultDesktopSettings.confirmations } }))}>{t("Restore safe confirmations")}</button>
      </section>
      <section className="settings-section settings-section-sharing">
        <h3>{t("Sharing")}</h3>
        <label className="settings-check">
          <input
            type="radio"
            name="shareLinkMode"
            checked={desktopSettings.shareLinkMode === "secure"}
            onChange={() => setDesktopSettings((current) => ({ ...current, shareLinkMode: "secure" }))}
          />
          <span><strong>{t("Secure share (web page link)")}</strong><small>{t("Opens the share.html page; supports an optional password. Use for sharing with people.")}</small></span>
        </label>
        <label className="settings-check">
          <input
            type="radio"
            name="shareLinkMode"
            checked={desktopSettings.shareLinkMode === "direct"}
            onChange={() => setDesktopSettings((current) => ({ ...current, shareLinkMode: "direct" }))}
          />
          <span><strong>{t("Direct link (for tools like BMC)")}</strong><small>{t("A plain file URL with no page and no Authorization header, for pasting into tools that only accept a bare link. No password protection.")}</small></span>
        </label>
        <label className="settings-level">{t("Default share link expiration")}
          <Dropdown
            label={t("Default share link expiration")}
            value={String(desktopSettings.shareLinkExpirationDays)}
            onChange={(value) => setDesktopSettings((current) => ({ ...current, shareLinkExpirationDays: Number(value) }))}
            options={[
              { value: "0", label: t("Server default") },
              { value: "1", label: t("1 day") },
              { value: "7", label: t("7 days") },
              { value: "30", label: t("30 days") },
              { value: "90", label: t("90 days") },
            ]}
          />
          <small>{t("Applied to every new share link created from this desktop app. The server also enforces its own configured maximum, so longer values may be rejected.")}</small>
        </label>
        <div className="settings-inline-action">
          <div><strong>{t("Share link management")}</strong><small>{t("Review, copy, or revoke links created by this desktop client.")}</small></div>
          <button type="button" onClick={onManageShareLinks} disabled={!canManageShareLinks}>{t("Manage Share Links")}</button>
        </div>
      </section>
      <section className="settings-section settings-section-history">
        <h3>{t("History and operation log")}</h3>
        <p>{t("Both are enabled by default. Undo records are reserved for reliable, verifiable reversals. The operation log is append-only, excludes secrets, rotates at 10 MB, and retains at most three files total.")}</p>
        <label className="settings-check"><input type="checkbox" checked={desktopSettings.undoHistoryEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, undoHistoryEnabled: event.target.checked }))} /><span><strong>{t("Enable undo history")}</strong><small>{t("Disabling this stops new undo records; it does not delete files.")}</small></span></label>
        <label className="settings-check"><input type="checkbox" checked={desktopSettings.operationLogEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, operationLogEnabled: event.target.checked }))} /><span><strong>{t("Enable operation log")}</strong><small>{t("Disabling this stops new audit records; it does not delete unrelated data.")}</small></span></label>
        <label className="settings-level">{t("Log detail level")}
          <Dropdown
            label={t("Log detail level")}
            value={desktopSettings.operationLogLevel}
            onChange={(value) => setDesktopSettings((current) => ({ ...current, operationLogLevel: value as DesktopSettings["operationLogLevel"] }))}
            options={[
              { value: "DEBUG", label: t("DEBUG - diagnostics and operations") },
              { value: "INFO", label: t("INFO - normal operations") },
              { value: "WARN", label: t("WARN - warnings and failures") },
              { value: "ERROR", label: t("ERROR - failures only") },
            ]}
          />
          <small>{t("DEBUG is enabled by default during development. Lower levels reduce diagnostic detail.")}</small>
        </label>
        {storageInfo && <div className="storage-info"><span>{t("History")}: {storageInfo.historyPath} ({formatSize(storageInfo.historyBytes, toIntlLocale(getAppLocale()))})</span><span>{t("Logs")}: {storageInfo.logPath} ({formatSize(storageInfo.logBytes, toIntlLocale(getAppLocale()))})</span><span>{t("{{files}} currently retained", { files: formatQuantity(storageInfo.logFiles.length, "log file", "log files") })}</span></div>}
        <div className="modal-actions settings-actions"><button type="button" onClick={onClearHistory}>{t("Clear undo history")}</button><button type="button" className="danger" onClick={onClearLogs}>{t("Clear operation logs")}</button></div>
      </section>
    </FloatingWindow>
  );
}

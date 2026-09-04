import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { themeStyle, type ThemePreset } from "../../styles/theme";
import {
  defaultDesktopSettings,
  desktopSettingsKey,
  normalizeDesktopSettings,
  type DesktopSettings,
  type OperationStorageInfo,
  type SettingsPanel,
} from "./settings-contracts";

export type UseDesktopSettingsParams = {
  // Only used by the operation-log-lifecycle effect to surface a startup
  // failure the same way every other DesktopApp error path does; passed in
  // rather than imported so this hook stays free of any main.tsx import.
  setNotice: React.Dispatch<React.SetStateAction<string>>;
};

// Owns every piece of state behind the Settings modal: the modal's own
// open/sub-panel navigation state, the persisted DesktopSettings object
// itself, the derived theme CSS variables, the "what was active before
// Settings opened" snapshot used by the theme Revert button, and the
// on-disk storage/log size summary shown in the History panel. Handlers
// that also depend on cross-cutting DesktopApp utilities (`run`, `notify`)
// -- refreshStorageInfo, clearHistory, clearLogs -- stay in main.tsx
// instead of here, since those utilities are declared partway through
// DesktopApp's render body and this hook is called near the top of it.
export function useDesktopSettings({ setNotice }: UseDesktopSettingsParams) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPanel, setSettingsPanel] = useState<SettingsPanel | null>(null);
  useEffect(() => { if (!settingsOpen) setSettingsPanel(null); }, [settingsOpen]);

  // T-216: captures the theme/accent that was active when Settings was
  // opened, so selecting a theme in the picker can apply it live (a
  // "preview", since it takes effect immediately the same way it always
  // has) while still letting Revert restore exactly what was active
  // before Settings was opened -- without this, the only way back to the
  // previous theme was re-selecting it by hand from the dropdown.
  const themeSnapshotRef = useRef<{ theme: ThemePreset; accentColor: string } | null>(null);

  const [desktopSettings, setDesktopSettings] = useState<DesktopSettings>(() => {
    try {
      return normalizeDesktopSettings(JSON.parse(localStorage.getItem(desktopSettingsKey) || "null"));
    } catch {
      return defaultDesktopSettings;
    }
  });

  useEffect(() => {
    if (settingsOpen) themeSnapshotRef.current = { theme: desktopSettings.theme, accentColor: desktopSettings.accentColor };
  }, [settingsOpen, desktopSettings.theme, desktopSettings.accentColor]);

  // T-212: compute themeStyle()'s result once per theme/accent change and
  // reuse it both for the documentElement side-effect below and for
  // AppShell's inline style prop in main.tsx, instead of calling
  // themeStyle() a second, independent time at the AppShell call site.
  // Portaled surfaces (.account-menu, .context-picker-popover, the
  // commandbar overflow menu, the REST Token JSON Path help popup) render
  // outside AppShell's own DOM subtree via createPortal(..., document.
  // body), so they read theme colors from document.documentElement's CSS
  // custom properties -- set by the effect below -- rather than from
  // AppShell's inline style; T-213 confirmed this by construction: nothing
  // about consolidating the *computation* into one memo changes which of
  // the two consumers (documentElement vs. AppShell) any given surface
  // reads from, so portaled surfaces keep recoloring immediately on theme
  // change exactly as before.
  const themeVariables = useMemo(
    () => themeStyle(desktopSettings.theme, desktopSettings.accentColor),
    [desktopSettings.theme, desktopSettings.accentColor],
  );
  useEffect(() => {
    Object.entries(themeVariables).forEach(([name, value]) => {
      if (typeof value === "string") document.documentElement.style.setProperty(name, value);
    });
  }, [themeVariables]);

  const [storageInfo, setStorageInfo] = useState<OperationStorageInfo | null>(null);

  useEffect(() => {
    localStorage.setItem(desktopSettingsKey, JSON.stringify(desktopSettings));
    // Mirror the enabled/level setting into the Rust process so
    // Rust-originated log calls (SSH auth attempts, connect/disconnect,
    // create/rename, drag staging, etc.) respect the same configuration the
    // user set here instead of only ever using the process's startup
    // defaults.
    void invoke("set_operation_log_config", {
      enabled: desktopSettings.operationLogEnabled,
      level: desktopSettings.operationLogLevel,
    }).catch(() => {});
    // Mirror the "allow legacy SSH algorithms" toggle the same way, so a
    // change takes effect on the very next connect attempt (terminal, SFTP
    // browser, or key install) instead of only after restarting the app.
    void invoke("ssh_set_allow_legacy_algorithms", {
      enabled: desktopSettings.allowLegacySshAlgorithms,
    }).catch(() => {});
  }, [desktopSettings]);

  useEffect(() => {
    if (!desktopSettings.operationLogEnabled) return undefined;
    void invoke("set_operation_log_config", {
      enabled: desktopSettings.operationLogEnabled,
      level: desktopSettings.operationLogLevel,
    }).then(() => invoke("initialize_operation_log"))
      .then(() => invoke("append_operation_log", {
        level: desktopSettings.operationLogLevel,
        operation: "app",
        status: "started",
        sourceLabel: "Desktop",
        destinationLabel: "",
        detail: "nFterm started.",
      }))
      .catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    return () => {
      void invoke("append_operation_log", {
        level: desktopSettings.operationLogLevel,
        operation: "app",
        status: "stopped",
        sourceLabel: "Desktop",
        destinationLabel: "",
        detail: "nFterm stopped.",
      }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per mount by design, mirroring the original inline effect.
  }, []);

  return {
    settingsOpen, setSettingsOpen,
    settingsPanel, setSettingsPanel,
    themeSnapshotRef,
    desktopSettings, setDesktopSettings,
    themeVariables,
    storageInfo, setStorageInfo,
  };
}

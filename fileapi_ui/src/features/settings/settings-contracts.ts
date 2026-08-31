import { themePresets, type ThemePreset } from "../../styles/theme";

// localStorage key that holds the serialized DesktopSettings object. Also
// read directly (without going through normalizeDesktopSettings) by
// main.tsx's top-level App() component to seed the "uiProfile" toggle
// before login, and by DesktopApp's appMode initializer before the
// useDesktopSettings hook itself has run -- so this constant must stay
// exported and stable, not folded away as a private detail of the hook.
export const desktopSettingsKey = "nfterm-settings";

export type DesktopSettings = {
  uiProfile: "auto" | "mobile";
  theme: ThemePreset;
  accentColor: string;
  glassMainEnabled: boolean;
  glassMenusEnabled: boolean;
  glassDialogsEnabled: boolean;
  proxmoxVncModeEnabled: boolean;
  restApiModeEnabled: boolean;
  collapseMainPaneEnabled: boolean;
  bracketedPasteControlEnabled: boolean;
  undoHistoryEnabled: boolean;
  operationLogEnabled: boolean;
  operationLogLevel: "DEBUG" | "INFO" | "WARN" | "ERROR";
  shareLinkExpirationDays: number;
  // "secure": share.html page link (can be password-protected, matches the
  // web UI's share flow). "direct": a plain, unauthenticated file URL meant
  // for tools that only accept a bare link (e.g. a BMC firmware page) and
  // cannot open a web page or send an Authorization header.
  shareLinkMode: "secure" | "direct";
  confirmations: {
    delete: boolean;
    overwrite: boolean;
    recursive: boolean;
    crossSourceMove: boolean;
  };
};
export type SettingsPanel = "theme" | "features" | "confirmations" | "sharing" | "history";

export type OperationStorageInfo = {
  historyPath: string;
  logPath: string;
  historyBytes: number;
  logBytes: number;
  logFiles: string[];
};

export const defaultDesktopSettings: DesktopSettings = {
  uiProfile: "auto",
  theme: "bridge",
  accentColor: "#63e6ff",
  glassMainEnabled: true,
  glassMenusEnabled: true,
  glassDialogsEnabled: true,
  proxmoxVncModeEnabled: false,
  restApiModeEnabled: false,
  collapseMainPaneEnabled: false,
  bracketedPasteControlEnabled: false,
  undoHistoryEnabled: true,
  operationLogEnabled: true,
  operationLogLevel: "DEBUG",
  // 0 = server default (currently 1 day); the server also enforces its own
  // configured maximum (shareLinks.maxExpiration), so values here that
  // exceed it are rejected server-side with a clear error.
  shareLinkExpirationDays: 0,
  // Defaults to the safer, page-based link (matches the web UI's default
  // behaviour). Users who need a bare URL for BMC/tooling must opt in.
  shareLinkMode: "secure",
  confirmations: { delete: true, overwrite: true, recursive: true, crossSourceMove: true },
};

// T-215: a single shared validate/merge function replaces what used to be
// an ever-growing inline sequence of individual `saved?.field === ... ?
// saved.field : default.field` checks at the desktopSettings useState
// initializer. Adding a new settings field now means adding one line here
// instead of extending that inline block; every field's own validator is
// intentionally still spelled out explicitly (no generic schema-inference
// magic) so a field's exact accepted shape stays easy to read and audit,
// the same as the individual checks being replaced.
export const normalizeDesktopSettings = (raw: unknown): DesktopSettings => {
  const saved = (raw && typeof raw === "object" ? raw : {}) as Partial<DesktopSettings> & Record<string, unknown>;
  const pick = <T,>(value: unknown, isValid: (value: unknown) => boolean, fallback: T): T =>
    isValid(value) ? (value as T) : fallback;
  return {
    ...defaultDesktopSettings,
    ...saved,
    uiProfile: pick(saved.uiProfile, (value) => value === "auto" || value === "mobile", defaultDesktopSettings.uiProfile),
    theme: pick(
      saved.theme,
      (value) => typeof value === "string" && Object.prototype.hasOwnProperty.call(themePresets, value),
      defaultDesktopSettings.theme,
    ),
    accentColor: pick(
      saved.accentColor,
      (value) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value),
      defaultDesktopSettings.accentColor,
    ),
    glassMainEnabled: pick(saved.glassMainEnabled, (value) => typeof value === "boolean", defaultDesktopSettings.glassMainEnabled),
    glassMenusEnabled: pick(saved.glassMenusEnabled, (value) => typeof value === "boolean", defaultDesktopSettings.glassMenusEnabled),
    glassDialogsEnabled: pick(saved.glassDialogsEnabled, (value) => typeof value === "boolean", defaultDesktopSettings.glassDialogsEnabled),
    operationLogLevel: pick(
      saved.operationLogLevel,
      (value) => typeof value === "string" && ["DEBUG", "INFO", "WARN", "ERROR"].includes(value),
      defaultDesktopSettings.operationLogLevel,
    ),
    shareLinkExpirationDays: pick(
      saved.shareLinkExpirationDays,
      (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
      defaultDesktopSettings.shareLinkExpirationDays,
    ),
    shareLinkMode: pick(
      saved.shareLinkMode,
      (value) => value === "secure" || value === "direct",
      defaultDesktopSettings.shareLinkMode,
    ),
    proxmoxVncModeEnabled: pick(
      saved.proxmoxVncModeEnabled,
      (value) => typeof value === "boolean",
      defaultDesktopSettings.proxmoxVncModeEnabled,
    ),
    restApiModeEnabled: pick(
      saved.restApiModeEnabled,
      (value) => typeof value === "boolean",
      defaultDesktopSettings.restApiModeEnabled,
    ),
    collapseMainPaneEnabled: pick(
      saved.collapseMainPaneEnabled,
      (value) => typeof value === "boolean",
      defaultDesktopSettings.collapseMainPaneEnabled,
    ),
    bracketedPasteControlEnabled: pick(
      saved.bracketedPasteControlEnabled,
      (value) => typeof value === "boolean",
      defaultDesktopSettings.bracketedPasteControlEnabled,
    ),
    confirmations: { ...defaultDesktopSettings.confirmations, ...(saved.confirmations || {}) },
  };
};

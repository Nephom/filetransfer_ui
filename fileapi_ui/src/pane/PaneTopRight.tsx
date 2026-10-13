import { useAppTranslation } from "../i18n/useAppTranslation";
import React from "react";
import { createPortal } from "react-dom";
import type { AppLocale } from "../i18n/i18n";
import { AccountIcon, QueueIcon, SettingsIcon } from "./pane-icons";

type Props = {
  session: { username: string; role: string; localOnly: boolean };
  accountOpen: boolean;
  accountControl: React.Ref<HTMLDivElement>;
  accountMenuStyle: React.CSSProperties;
  activeQueueCount: number;
  onOpenQueue: () => void;
  onAccountToggle: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onOpenSessions: () => void;
  onOpenSettings: () => void;
  onChangePassword: () => void;
  onOpenLogView: () => void;
  onOpenHelp: () => void;
  onOpenWelcomeTutorial: () => void;
  onSignOut: () => void;
  locale: AppLocale;
  onLocaleChange: (locale: AppLocale) => void;
};

/** Pills in the top-right corner of the desktop: transfer queue, settings and the account menu. */
export function PaneTopRight({
  session, accountOpen, accountControl, accountMenuStyle, activeQueueCount,
  onOpenQueue, onAccountToggle, onOpenSessions, onOpenSettings, onChangePassword, onOpenLogView, onOpenHelp, onOpenWelcomeTutorial, onSignOut,
  locale, onLocaleChange,
}: Props) {
  const { t } = useAppTranslation();
  const roleLabel = session.localOnly ? t("Local") : session.role === "admin" ? t("Admin") : session.role === "superuser" ? t("Superuser") : t("User");
  const roleDescription = session.localOnly ? t("Local-only mode") : session.role === "admin" ? t("System administrator") : session.role === "superuser" ? t("Superuser") : t("Standard user");
  return (
    <>
      <button
        type="button"
        className={`pane-pill pane-pill-button${activeQueueCount > 0 ? " is-busy" : ""}`}
        onClick={onOpenQueue}
        title={t("Transfer Queue")}
        aria-label={t("Transfer Queue, {{count}} active", { count: activeQueueCount })}
      >
        <QueueIcon size={18} />
        <span className="pane-pill-count">{activeQueueCount}</span>
      </button>
      <button type="button" className="pane-pill pane-pill-button pane-pill-icon" onClick={onOpenSettings} title={t("Settings")} aria-label={t("Settings")}>
        <SettingsIcon size={18} />
      </button>
      <div className="account-control" ref={accountControl}>
        <button type="button" className="pane-pill pane-pill-button account" onClick={onAccountToggle} aria-expanded={accountOpen} aria-haspopup="menu">
          <AccountIcon size={18} />
          <span className="pane-account-name">{session.username}</span>
          <span className="account-role">{roleLabel}</span>
        </button>
        {accountOpen && createPortal(
          <div className="account-menu" style={accountMenuStyle} role="menu" aria-label={t("Account menu")}>
            <div className="account-summary">
              <strong>{session.username}</strong>
              <span>{roleDescription}</span>
            </div>
            <button role="menuitem" onClick={onOpenSessions}>{t("Workspace Manager")}</button>
            <button role="menuitem" onClick={onOpenSettings}>{t("Settings")}</button>
            {!session.localOnly && session.role !== "admin" && <button role="menuitem" onClick={onChangePassword}>{t("Change password")}</button>}
            <button role="menuitem" onClick={onOpenLogView}>{t("LogView")}</button>
            <button role="menuitem" onClick={onOpenHelp}>{t("Help")}</button>
            <button role="menuitem" onClick={onOpenWelcomeTutorial}>{t("Tutorial")}</button>
            <div className="account-language" role="group" aria-label={t("Language")}>
              <label htmlFor="account-locale-select">{t("Language")}</label>
              <select id="account-locale-select" value={locale} onChange={(event) => onLocaleChange(event.target.value as AppLocale)}>
                <option value="en_US">English (United States)</option>
                <option value="zh_TW">繁體中文（台灣）</option>
              </select>
            </div>
            <hr />
            <button className="danger" role="menuitem" onClick={onSignOut}>{t("Log out")}</button>
          </div>,
          document.body,
        )}
      </div>
    </>
  );
}

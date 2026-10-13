import { useAppTranslation } from "../../i18n/useAppTranslation";
import React from "react";
import "../../help/help.css";
import { helpPageIcon, HelpIcon, helpPages, helpSections } from "../../help/help-content";
import { FloatingWindow } from "../../ui/FloatingWindow";
import { CloseIcon } from "../../ui/icons";

type HelpModalProps = {
  selectedPageId: string;
  expandedSections: string[];
  modalStyle: React.CSSProperties;
  onDragStart: (event: React.MouseEvent<HTMLElement>) => void;
  onClose: () => void;
  onToggleSection: (id: string) => void;
  onSelectPage: (id: string) => void;
};

function translateNode(node: React.ReactNode, t: (key: string) => string): React.ReactNode {
  return React.Children.map(node, (child) => {
    if (typeof child === "string") {
      const match = child.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (!match || !match[2]) return child;
      const translated = t(match[2]);
      // Preserve source spacing around inline controls/code, but do not leave
      // a space before punctuation when a translated fragment starts with it.
      const leading = /^[,.;:!?，。；：！？]/u.test(translated) ? "" : match[1];
      const trailing = /[,.;:!?，。；：！？]$/u.test(translated) ? "" : match[3];
      return `${leading}${translated}${trailing}`;
    }
    if (React.isValidElement<{ children?: React.ReactNode }>(child) && child.props.children) {
      if (child.type === "code" || child.type === "pre") return child;
      return React.cloneElement(child, undefined, translateNode(child.props.children, t));
    }
    return child;
  });
}

export function HelpModal({ selectedPageId, expandedSections, modalStyle, onDragStart, onClose, onToggleSection, onSelectPage }: HelpModalProps) {
  const { t } = useAppTranslation();
  const selectedPage = helpPages.find((page) => page.id === selectedPageId) || helpPages[0];
  const selectedSection = helpSections.find((section) => section.pages.some((page) => page.id === selectedPage.id)) || helpSections[0];
  const selectedIndex = helpPages.findIndex((page) => page.id === selectedPage.id);

  return (
    <FloatingWindow
      ariaLabel={t("nFterm Help")}
      className="help-modal"
      style={modalStyle}
      onClose={onClose}
      onDragStart={onDragStart}
      header={(
        <div className="help-heading">
          <HelpIcon name="book" />
          <div><h2 id="help-title">{t("nFterm Help")}</h2><p>{t("User guide, SSH help, and technical reference.")}</p></div>
          <button type="button" className="help-close" onClick={onClose} aria-label={t("Close Help")}><CloseIcon /></button>
        </div>
      )}
      footer={(
        <footer className="help-footer">
          <span>{t("Page {{current}} of {{total}}", { current: selectedIndex + 1, total: helpPages.length })}</span>
          <div className="help-page-nav">
            <button type="button" disabled={selectedIndex <= 0} onClick={() => onSelectPage(helpPages[selectedIndex - 1].id)}>{t("Previous")}</button>
            <button type="button" disabled={selectedIndex >= helpPages.length - 1} onClick={() => onSelectPage(helpPages[selectedIndex + 1].id)}>{t("Next")}</button>
            <button type="button" onClick={onClose}>{t("Close")}</button>
          </div>
        </footer>
      )}
    >
      <div className="help-layout">
        <nav className="help-tree" aria-label={t("Help topics")}>
          {helpSections.map((section) => {
            const expanded = expandedSections.includes(section.id);
            return <div className="help-tree-section" key={section.id}>
              <button type="button" className="help-tree-toggle" aria-expanded={expanded} onClick={() => onToggleSection(section.id)}>
                <span className="help-tree-chevron" aria-hidden="true">{expanded ? "−" : "+"}</span><HelpIcon name={section.icon} size={16} /><span>{t(section.title)}</span>
              </button>
              {expanded && <div className="help-tree-pages">{section.pages.map((page) => <button type="button" key={page.id} className={`help-tree-page${selectedPage.id === page.id ? " active" : ""}`} aria-current={selectedPage.id === page.id ? "page" : undefined} onClick={() => onSelectPage(page.id)}><HelpIcon name={helpPageIcon(page.id, section.icon)} size={14} /><span>{t(page.title)}</span></button>)}</div>}
            </div>;
          })}
        </nav>
        <article className="help-content" aria-live="polite">
          <div className="help-breadcrumb">{t(selectedSection.title)}</div>
          <h3 className="help-page-title"><HelpIcon name={selectedPage.icon || helpPageIcon(selectedPage.id, selectedSection.icon)} size={22} />{t(selectedPage.title)}</h3>
          <p className="help-summary">{t(selectedPage.summary)}</p>
          {translateNode(selectedPage.content, t)}
        </article>
      </div>
    </FloatingWindow>
  );
}

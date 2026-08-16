import React from "react";
import "../../help/help.css";
import { HelpIcon, type HelpPage, type HelpSection } from "../../help/help-content";
import { FloatingWindow } from "../../ui/FloatingWindow";
import { CloseIcon } from "../../ui/icons";

type HelpModalProps = {
  sections: HelpSection[];
  pages: HelpPage[];
  selectedPage: HelpPage;
  selectedSection: HelpSection;
  selectedIndex: number;
  expandedSections: string[];
  modalStyle: React.CSSProperties;
  onDragStart: (event: React.MouseEvent<HTMLElement>) => void;
  onClose: () => void;
  onToggleSection: (id: string) => void;
  onSelectPage: (id: string) => void;
};

export function HelpModal({ sections, pages, selectedPage, selectedSection, selectedIndex, expandedSections, modalStyle, onDragStart, onClose, onToggleSection, onSelectPage }: HelpModalProps) {
  return (
    <FloatingWindow
      ariaLabel="nFterm Help"
      className="help-modal"
      style={modalStyle}
      onClose={onClose}
      onDragStart={onDragStart}
      header={(
        <div className="help-heading">
          <HelpIcon name="book" />
          <div><h2 id="help-title">nFterm Help</h2><p>操作說明、SSH 指南與技術文件</p></div>
          <button type="button" className="help-close" onClick={onClose} aria-label="Close Help"><CloseIcon /></button>
        </div>
      )}
      footer={(
        <footer className="help-footer">
          <span>頁面 {selectedIndex + 1} / {pages.length}</span>
          <div className="help-page-nav">
            <button type="button" disabled={selectedIndex <= 0} onClick={() => onSelectPage(pages[selectedIndex - 1].id)}>Previous</button>
            <button type="button" disabled={selectedIndex >= pages.length - 1} onClick={() => onSelectPage(pages[selectedIndex + 1].id)}>Next</button>
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </footer>
      )}
    >
      <div className="help-layout">
        <nav className="help-tree" aria-label="Help topics">
          {sections.map((section) => {
            const expanded = expandedSections.includes(section.id);
            return <div className="help-tree-section" key={section.id}>
              <button type="button" className="help-tree-toggle" aria-expanded={expanded} onClick={() => onToggleSection(section.id)}>
                <span className="help-tree-chevron" aria-hidden="true">{expanded ? "−" : "+"}</span><HelpIcon name={section.icon} size={16} /><span>{section.title}</span>
              </button>
              {expanded && <div className="help-tree-pages">{section.pages.map((page) => <button type="button" key={page.id} className={`help-tree-page${selectedPage.id === page.id ? " active" : ""}`} aria-current={selectedPage.id === page.id ? "page" : undefined} onClick={() => onSelectPage(page.id)}>{page.title}</button>)}</div>}
            </div>;
          })}
        </nav>
        <article className="help-content" aria-live="polite">
          <div className="help-breadcrumb">{selectedSection.title}</div>
          <h3>{selectedPage.title}</h3>
          <p className="help-summary">{selectedPage.summary}</p>
          {selectedPage.content}
        </article>
      </div>
    </FloatingWindow>
  );
}

import React, { useState } from "react";
import {
  EntryManagerIcon,
  ExternalWindowIcon,
  FunctionsIcon,
  LocalIcon,
  LocationIcon,
  RemoteIcon,
  RestIcon,
  SftpIcon,
  SshEntriesIcon,
  TerminalIcon,
  VncIcon,
} from "./pane-icons";

type Props = {
  initialOnlyFirstLaunch: boolean;
  onDismiss: (onlyFirstLaunch: boolean) => void;
};

const WIZARD_PAGES: { title: string; content: React.ReactNode }[] = [
  {
    title: "Welcome to nFterm",
    content: <>
      <div className="pane-welcome-hero" aria-hidden="true">
        <span className="pane-welcome-hero-icon"><FunctionsIcon size={42} /></span>
        <div>
          <strong>Start from the dock</strong>
          <span>Open locations and tools when you need them.</span>
        </div>
      </div>
      <p className="pane-welcome-lead">Welcome. Use the dock at the bottom of the desktop to open the tools you need.</p>
      <p>Functions opens locations and optional tools. Terminal is where you create SSH workspaces and start SSH sessions.</p>
    </>,
  },
  {
    title: "Explore Functions",
    content: <>
      <p className="pane-welcome-lead">Open <strong>Functions</strong> in the dock to find:</p>
      <div className="pane-welcome-feature-grid">
        <article className="pane-welcome-feature pane-welcome-feature-location">
          <span className="pane-welcome-feature-icon"><LocationIcon size={24} /></span>
          <div><strong>Location</strong><span>Browse Local files, API Remote locations, and SFTP for connected SSH entries.</span></div>
          <div className="pane-welcome-location-icons" aria-hidden="true">
            <span><LocalIcon size={17} />Local</span><span><RemoteIcon size={17} />Remote</span><span><SftpIcon size={17} />SFTP</span>
          </div>
        </article>
        <article className="pane-welcome-feature">
          <span className="pane-welcome-feature-icon"><VncIcon size={24} /></span>
          <div><strong>VNC</strong><span>Remote console access when enabled in Settings.</span></div>
        </article>
        <article className="pane-welcome-feature">
          <span className="pane-welcome-feature-icon"><RestIcon size={24} /></span>
          <div><strong>RestAPI</strong><span>REST API tools when enabled in Settings.</span></div>
        </article>
      </div>
      <p>Select <strong>Location</strong> to choose Local, a Remote location, or an available SFTP entry.</p>
    </>,
  },
  {
    title: "Set up Terminal",
    content: <>
      <p className="pane-welcome-lead">To start an SSH session, first create its workspace and entry:</p>
      <ol className="pane-welcome-steps">
        <li>
          <span className="pane-welcome-step-icon"><EntryManagerIcon size={22} /></span>
          <div><strong>Create the Workspace and SSH Entry</strong><span>Open Terminal → Entry Manager, create or select a Workspace, then add an SSH Entry.</span></div>
        </li>
        <li>
          <span className="pane-welcome-step-icon"><SshEntriesIcon size={22} /></span>
          <div><strong>Choose the SSH Entry</strong><span>Open Terminal → SSH Entries and select your saved entry.</span></div>
        </li>
        <li>
          <span className="pane-welcome-step-icon"><TerminalIcon size={22} /></span>
          <div><strong>Open the terminal</strong><span>Choose Open SSH or <ExternalWindowIcon size={14} /> Open a new Window. The SSH session starts when the terminal opens.</span></div>
        </li>
      </ol>
      <p>You can reconnect from the terminal controls after a disconnect.</p>
    </>,
  },
];

export function WelcomeWizard({ initialOnlyFirstLaunch, onDismiss }: Props) {
  const [step, setStep] = useState(0);
  const [onlyFirstLaunch, setOnlyFirstLaunch] = useState(initialOnlyFirstLaunch);
  const currentPage = WIZARD_PAGES[step];
  const isLastPage = step === WIZARD_PAGES.length - 1;

  return (
    <section className="pane-welcome-overlay" aria-labelledby="pane-welcome-title">
      <div className="pane-welcome-card">
        <header className="pane-welcome-heading">
          <div>
            <span className="pane-welcome-eyebrow">nFterm · GETTING STARTED</span>
            <h1 id="pane-welcome-title">{currentPage.title}</h1>
          </div>
          <span className="pane-welcome-step" aria-live="polite">{step + 1} / {WIZARD_PAGES.length}</span>
        </header>

        <div className="pane-welcome-content" aria-live="polite" aria-labelledby="pane-welcome-title">{currentPage.content}</div>

        <div className="pane-welcome-progress" aria-hidden="true">
          {WIZARD_PAGES.map((page, index) => <span key={page.title} className={index === step ? "active" : index < step ? "complete" : ""} />)}
        </div>

        <footer className="pane-welcome-footer">
          <label className="pane-welcome-once">
            <input type="checkbox" checked={onlyFirstLaunch} onChange={(event) => setOnlyFirstLaunch(event.target.checked)} />
            <span>Show this tutorial only on the first launch</span>
          </label>
          <nav className="pane-welcome-actions" aria-label="Tutorial navigation">
            {step > 0 && <button type="button" onClick={() => setStep((current) => current - 1)}>Previous</button>}
            <button type="button" className="pane-welcome-skip" onClick={() => onDismiss(onlyFirstLaunch)}>Skip tutorial</button>
            {!isLastPage
              ? <button type="button" className="confirm" onClick={() => setStep((current) => current + 1)}>Next</button>
              : <button type="button" className="confirm" onClick={() => onDismiss(onlyFirstLaunch)}>Finish</button>}
          </nav>
        </footer>
      </div>
    </section>
  );
}

import { useEffect } from "react";
import type { SshProfile } from "../ssh/ssh-contracts";
import { SshEntryTerminalView } from "./SshEntryTerminalView";
import { useSshEntryTerminal, type SshEntryOperationLog, type SshEntryTerminalState } from "./useSshEntryTerminal";

type Props = {
  /** The pane window id (`ssh:<entryId>#<n>`); the same entry can have several panes. */
  windowId: string;
  profile: SshProfile;
  title: string;
  bracketedPasteControlEnabled: boolean;
  /** Reports connection / recording state per pane; `null` once the pane is gone. */
  onStateChange: (windowId: string, entryId: string, state: SshEntryTerminalState | null) => void;
  onOperationLog: SshEntryOperationLog;
};

/**
 * Body of an `ssh:<entryId>#<n>` pane window: one terminal of the SSH entry.
 * It connects when the window opens and disconnects (discarding an unsaved
 * recording) when the window is closed and this component unmounts. Every pane
 * has its own session, so opening the same entry again gives an independent one.
 */
export function SshEntryPane({ windowId, profile, title, bracketedPasteControlEnabled, onStateChange, onOperationLog }: Props) {
  const entryId = profile.id;
  const terminal = useSshEntryTerminal({
    profile,
    title,
    source: "SSH pane",
    autoConnect: true,
    bracketedPasteControlEnabled,
    onStateChange: (state) => onStateChange(windowId, entryId, state),
    onOperationLog,
  });
  useEffect(() => () => onStateChange(windowId, entryId, null), [windowId, entryId]);
  return <SshEntryTerminalView terminal={terminal} title={title} variant="pane" />;
}

import { useEffect } from "react";
import type { SshProfile } from "../ssh/ssh-contracts";
import { SshEntryTerminalView } from "./SshEntryTerminalView";
import { useSshEntryTerminal, type SshEntryOperationLog, type SshEntryTerminalState } from "./useSshEntryTerminal";

type Props = {
  profile: SshProfile;
  title: string;
  bracketedPasteControlEnabled: boolean;
  /** Reports connection / recording state per entry; `null` once the pane is gone. */
  onStateChange: (entryId: string, state: SshEntryTerminalState | null) => void;
  onOperationLog: SshEntryOperationLog;
};

/**
 * Body of an `ssh:<entryId>` pane window: the SSH entry's own terminal.
 * It connects when the window opens and disconnects (discarding an unsaved
 * recording) when the window is closed and this component unmounts.
 */
export function SshEntryPane({ profile, title, bracketedPasteControlEnabled, onStateChange, onOperationLog }: Props) {
  const entryId = profile.id;
  const terminal = useSshEntryTerminal({
    profile,
    title,
    source: "SSH pane",
    autoConnect: true,
    bracketedPasteControlEnabled,
    onStateChange: (state) => onStateChange(entryId, state),
    onOperationLog,
  });
  useEffect(() => () => onStateChange(entryId, null), [entryId]);
  return <SshEntryTerminalView terminal={terminal} title={title} variant="pane" />;
}

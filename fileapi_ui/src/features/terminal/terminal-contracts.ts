import type { SshProfile } from "../ssh/ssh-contracts";

export type SshTerminalTab = {
  id: string;
  title: string;
  workspaceId: string;
  sshEntryId: string;
  sessionId: string;
  connected: boolean;
  connecting?: boolean;
  output: string;
  recording: boolean;
  recordingStartedAt: number | null;
  recordingRawBytes: number;
  recordingPlainBytes: number;
  recordingCommandCount: number;
  savedLogPaths: string[];
};

export type RecordingStats = {
  rawBytes: number;
  plainBytes: number;
  commandCount: number;
};

export type TerminalWorkspaceSession = {
  id: string;
  name: string;
  sshEntries: SshProfile[];
};

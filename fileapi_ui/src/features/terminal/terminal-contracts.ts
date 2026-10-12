export type LocalTerminalKind = "windowsTerminal" | "cmd";

export type RecordingIndicator = "REC" | "LOG" | null;

export type RecordingStats = {
  rawBytes: number;
  plainBytes: number;
  commandCount: number;
};

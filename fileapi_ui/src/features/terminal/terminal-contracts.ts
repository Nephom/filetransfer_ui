export type LocalTerminalKind = "windowsTerminal" | "cmd";

export type RecordingStats = {
  rawBytes: number;
  plainBytes: number;
  commandCount: number;
};

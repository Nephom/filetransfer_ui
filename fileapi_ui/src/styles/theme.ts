import type React from "react";

export type ThemePreset = "bridge" | "graphite" | "emerald" | "tech-silver";

type ThemeVariables = {
  void: string;
  space: string;
  panel: string;
  panelStrong: string;
  line: string;
  cyan: string;
  blue: string;
  green: string;
  amber: string;
  red: string;
  text: string;
  muted: string;
};

export const themePresets: Record<ThemePreset, { label: string; variables: ThemeVariables }> = {
  bridge: {
    label: "Bridge blue",
    variables: { void: "#020711", space: "#061322", panel: "rgba(8, 27, 46, .72)", panelStrong: "rgba(10, 34, 56, .9)", line: "rgba(107, 201, 239, .26)", cyan: "#63e6ff", blue: "#318bff", green: "#5df2bd", amber: "#f2bd63", red: "#ff657f", text: "#e9f8ff", muted: "#8caec5" },
  },
  graphite: {
    label: "Graphite violet",
    variables: { void: "#0b0c12", space: "#151622", panel: "rgba(29, 30, 45, .84)", panelStrong: "rgba(37, 38, 57, .96)", line: "rgba(190, 181, 255, .28)", cyan: "#c1b7ff", blue: "#8f82ff", green: "#6ee7b7", amber: "#f5c66d", red: "#ff879c", text: "#f2f0ff", muted: "#aaa6c4" },
  },
  emerald: {
    label: "Emerald terminal",
    variables: { void: "#03100d", space: "#062019", panel: "rgba(7, 39, 31, .8)", panelStrong: "rgba(9, 51, 40, .94)", line: "rgba(93, 242, 189, .28)", cyan: "#67f4c2", blue: "#4cb8ff", green: "#8ff7b5", amber: "#f2d37b", red: "#ff8294", text: "#e8fff5", muted: "#91c6b4" },
  },
  "tech-silver": {
    label: "Tech silver",
    variables: { void: "#0a0f15", space: "#121a23", panel: "rgba(24, 34, 45, .86)", panelStrong: "rgba(32, 44, 57, .96)", line: "rgba(184, 199, 217, .3)", cyan: "#c5d5e6", blue: "#8da9c4", green: "#7ed6b0", amber: "#e5c27e", red: "#f08f9b", text: "#eef3f8", muted: "#a9b8c7" },
  },
};

export const themeStyle = (preset: ThemePreset, accentColor?: string): React.CSSProperties => {
  const variables = themePresets[preset].variables;
  const accent = accentColor && /^#[0-9a-f]{6}$/i.test(accentColor) ? accentColor : variables.cyan;
  return {
    "--bridge-void": variables.void,
    "--bridge-space": variables.space,
    "--bridge-panel": variables.panel,
    "--bridge-panel-strong": variables.panelStrong,
    "--bridge-line": variables.line,
    "--bridge-line-bright": accent,
    "--bridge-cyan": accent,
    "--bridge-blue": variables.blue,
    "--bridge-green": variables.green,
    "--bridge-amber": variables.amber,
    "--bridge-red": variables.red,
    "--bridge-text": variables.text,
    "--bridge-muted": variables.muted,
    "--bridge-popover": variables.panelStrong,
    "--bridge-account-popover": variables.panelStrong,
    "--bridge-popover-border": variables.line,
    "--color-bg": variables.void,
    "--color-bg-panel": variables.panel,
    "--color-bg-panel-strong": variables.panelStrong,
    "--color-text": variables.text,
    "--color-text-muted": variables.muted,
    "--color-primary": accent,
    "--color-secondary": variables.blue,
    "--color-success": variables.green,
    "--color-warning": variables.amber,
    "--color-danger": variables.red,
    "--color-border": variables.line,
    "--color-border-strong": accent,
  } as React.CSSProperties;
};

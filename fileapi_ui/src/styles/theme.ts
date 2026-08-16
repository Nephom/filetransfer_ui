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

// T-214: parses a #rrggbb hex string into 0-255 RGB components. Returns
// null for anything that isn't a well-formed 6-digit hex color (the same
// shape validated elsewhere by /^#[0-9a-f]{6}$/i).
const hexToRgb = (hex: string): [number, number, number] | null => {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return null;
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
};

// T-214: perceptual-ish Euclidean distance in RGB space, normalized to a
// 0-1 scale (0 = identical, 1 = maximum possible distance, i.e. black vs.
// white). This is a coarse approximation (not a real perceptual color
// model like CIEDE2000) deliberately -- it only needs to be good enough to
// flag "these two colors are close enough to visually collide," not to
// rank colors precisely.
const colorDistance = (a: string, b: string): number | null => {
  const rgbA = hexToRgb(a);
  const rgbB = hexToRgb(b);
  if (!rgbA || !rgbB) return null;
  const sumSquares = rgbA.reduce((total, channel, index) => total + (channel - rgbB[index]) ** 2, 0);
  return Math.sqrt(sumSquares) / Math.sqrt(3 * 255 ** 2);
};

// T-214: below this normalized distance, two colors are treated as
// visually colliding for the purposes of the accent-color warning in
// Desktop Settings -- e.g. picking an accent close to the active theme's
// danger/warning color would make delete buttons or elevated/danger
// drop-target highlighting hard to tell apart from the newly "selected"/
// focus-ring accent color.
const ACCENT_COLLISION_THRESHOLD = 0.16;

export type AccentCollision = { withDanger: boolean; withWarning: boolean };

// T-214: reports whether a candidate accent color would visually collide
// with the active theme preset's danger (red) or warning (amber) color.
// Exported so Desktop Settings' accent-color picker can surface an inline
// warning without duplicating the color-distance logic or the preset
// lookup.
export const accentCollidesWithSemanticColor = (preset: ThemePreset, accentColor: string): AccentCollision => {
  const variables = themePresets[preset].variables;
  const dangerDistance = colorDistance(accentColor, variables.red);
  const warningDistance = colorDistance(accentColor, variables.amber);
  return {
    withDanger: dangerDistance !== null && dangerDistance < ACCENT_COLLISION_THRESHOLD,
    withWarning: warningDistance !== null && warningDistance < ACCENT_COLLISION_THRESHOLD,
  };
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

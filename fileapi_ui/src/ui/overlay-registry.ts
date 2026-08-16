// Keep this scale in sync with the --z-* tokens declared in
// src/styles/tokens.css: dropdown 400, context 450, modal 500, toast 600.
export const overlayZIndex = {
  dropdown: 400,
  context: 450,
  modal: 500,
  toast: 600,
} as const;

export type OverlayLayer = keyof typeof overlayZIndex;

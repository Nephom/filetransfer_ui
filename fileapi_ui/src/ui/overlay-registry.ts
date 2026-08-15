export const overlayZIndex = {
  dropdown: 400,
  modal: 500,
  toast: 600,
} as const;

export type OverlayLayer = keyof typeof overlayZIndex;

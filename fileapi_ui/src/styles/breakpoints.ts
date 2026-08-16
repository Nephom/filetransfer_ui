export const MOBILE_MAX_WIDTH = 1024;
export const MOBILE_MAX_HEIGHT = 768;

export type ViewportSize = {
  width: number;
  height: number;
};

export const isMobileViewport = ({ width, height }: ViewportSize): boolean =>
  width <= MOBILE_MAX_WIDTH || height <= MOBILE_MAX_HEIGHT;

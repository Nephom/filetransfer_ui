import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript } from "./test-utils.js";

const tilePixels = new Map();
const outputCanvases = new Map();
let nextCanvasId = 1;

class ScreenshotImage {
  set src(value) {
    const key = value.split(",", 2)[1];
    this.tile = tilePixels.get(key);
    if (!this.tile) throw new Error(`Unknown screenshot fixture: ${key}`);
    this.naturalWidth = this.tile.width;
    this.naturalHeight = this.tile.height;
  }

  async decode() {}
  removeAttribute() {}
}

const colorValue = (color) => {
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), 255];
  const hex = /^#([\da-f]{6})$/i.exec(color);
  if (hex) return [
    Number.parseInt(hex[1].slice(0, 2), 16),
    Number.parseInt(hex[1].slice(2, 4), 16),
    Number.parseInt(hex[1].slice(4, 6), 16),
    255,
  ];
  throw new Error(`Unsupported fixture color: ${color}`);
};

class PixelCanvas {
  constructor() {
    this._width = 0;
    this._height = 0;
    this.pixels = new Uint8ClampedArray(0);
    this.context = new PixelContext(this);
  }

  set width(value) {
    this._width = value;
    this.pixels = new Uint8ClampedArray(this._width * this._height * 4);
  }
  get width() { return this._width; }

  set height(value) {
    this._height = value;
    this.pixels = new Uint8ClampedArray(this._width * this._height * 4);
  }
  get height() { return this._height; }

  getContext(kind) {
    return kind === "2d" ? this.context : null;
  }

  toDataURL() {
    const key = `stitched-${nextCanvasId++}`;
    outputCanvases.set(key, this);
    return `data:image/png;base64,${key}`;
  }
}

class PixelContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = "#000000";
  }

  write(x, y, color) {
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return;
    const index = (y * this.canvas.width + x) * 4;
    this.canvas.pixels.set(color, index);
  }

  clearRect(x, y, width, height) {
    for (let py = Math.floor(y); py < Math.ceil(y + height); py += 1) {
      for (let px = Math.floor(x); px < Math.ceil(x + width); px += 1) this.write(px, py, [0, 0, 0, 0]);
    }
  }

  fillRect(x, y, width, height) {
    const color = colorValue(this.fillStyle);
    for (let py = Math.floor(y); py < Math.ceil(y + height); py += 1) {
      for (let px = Math.floor(x); px < Math.ceil(x + width); px += 1) this.write(px, py, color);
    }
  }

  drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh) {
    const source = image.tile || image;
    for (let y = 0; y < dh; y += 1) {
      for (let x = 0; x < dw; x += 1) {
        const sourceX = Math.min(source.width - 1, Math.floor(sx + (x + 0.5) * sw / dw));
        const sourceY = Math.min(source.height - 1, Math.floor(sy + (y + 0.5) * sh / dh));
        const sourceIndex = (sourceY * source.width + sourceX) * 4;
        this.write(dx + x, dy + y, source.pixels.slice(sourceIndex, sourceIndex + 4));
      }
    }
  }

  getImageData(x, y) {
    const index = (y * this.canvas.width + x) * 4;
    return { data: this.canvas.pixels.slice(index, index + 4) };
  }
}

const fakeDocument = { createElement: (tag) => tag === "canvas" ? new PixelCanvas() : null };
const browserPane = loadTypeScript("features/browser/BrowserPane.tsx", {
  mocks: {
    "@tauri-apps/api/core": { invoke: async () => null },
    "@tauri-apps/api/event": { listen: async () => () => {} },
    "@tauri-apps/api/webviewWindow": { getCurrentWebviewWindow: () => ({}) },
    "../../ui/icons": {
      ChevronLeftIcon: () => null,
      ChevronRightIcon: () => null,
      RefreshIcon: () => null,
      StopIcon: () => null,
    },
    "./browser-snapshot-store": {
      captureBrowserSnapshot: async () => true,
      clearBrowserSnapshot() {},
      useBrowserSnapshot: () => undefined,
    },
  },
  globals: { Image: ScreenshotImage, document: fakeDocument },
});

const image = (width, height, color) => {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const rgba = colorValue(color);
  for (let index = 0; index < pixels.length; index += 4) pixels.set(rgba, index);
  return { width, height, pixels };
};

const paint = (tile, left, top, right, bottom, color) => {
  const rgba = colorValue(color);
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      tile.pixels.set(rgba, (y * tile.width + x) * 4);
    }
  }
};

const pixel = (canvas, x, y) => {
  const index = (y * canvas.width + x) * 4;
  return Array.from(canvas.pixels.slice(index, index + 4));
};

test("full-page screenshot preserves colored region placement across tiles and independent pixel scales", async () => {
  tilePixels.clear();
  outputCanvases.clear();
  nextCanvasId = 1;

  // A 40×30 CSS viewport whose screenshot pixels have different X/Y scales.
  const base = image(41, 31, "#202020");
  paint(base, 0, 0, 10, 31, "#00b400");
  paint(base, 30, 0, 41, 31, "#b400b4");
  paint(base, 10, 5, 31, 16, "#dc1414");
  const second = image(42, 32, "#202020");
  paint(second, 11, 5, 32, 16, "#1450e6");
  const third = image(42, 32, "#202020");
  paint(third, 11, 5, 32, 16, "#e6b414");
  tilePixels.set("base", base);
  tilePixels.set("second", second);
  tilePixels.set("third", third);

  const result = await browserPane.stitchBrowserScreenshot({
    viewportWidth: 40,
    viewportHeight: 30,
    region: {
      x: 10,
      y: 5,
      width: 20,
      height: 10,
      contentWidth: 20,
      contentHeight: 30,
      scrollbarWidth: 0,
      scrollbarHeight: 0,
      description: "colored fixture",
      truncated: false,
    },
    tiles: ["base", "second", "third"],
    placements: [
      { tile: 0, dstX: 0, dstY: 0, width: 20, height: 10 },
      { tile: 1, dstX: 0, dstY: 10, width: 20, height: 10 },
      { tile: 2, dstX: 0, dstY: 20, width: 20, height: 10 },
    ],
    skippedFrames: 0,
  });

  const output = outputCanvases.get(result.dataUrl.split(",", 2)[1]);
  assert.ok(output, "the stitched PNG canvas was produced");
  assert.equal(output.width, 41);
  assert.equal(output.height, 52);
  assert.deepEqual(pixel(output, 15, 10), [220, 20, 20, 255], "the first tile stays in the first visible region");
  assert.deepEqual(pixel(output, 15, 21), [20, 80, 230, 255], "the scrolled tile begins at its measured destination offset");
  assert.deepEqual(pixel(output, 15, 33), [230, 180, 20, 255], "the final tile reaches the bottom edge at the Y pixel scale");
  assert.deepEqual(pixel(output, 5, 21), [0, 180, 0, 255], "the expanded left margin keeps its sampled page color");
  assert.deepEqual(pixel(output, 35, 21), [180, 0, 180, 255], "the expanded right margin keeps its sampled page color");
});

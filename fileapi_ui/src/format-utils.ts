// Shared, presentation-only formatting helpers with no React/Tauri
// dependencies, used by multiple feature domains (file browser panes,
// transfer queue, settings storage panel, ...). Extracted out of main.tsx
// so those domains do not need to import from main.tsx itself.
export const formatSize = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 ** 2
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 ** 2).toFixed(1)} MB`;

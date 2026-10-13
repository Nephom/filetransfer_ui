// Shared, presentation-only formatting helpers with no React/Tauri
// dependencies, used by multiple feature domains (file browser panes,
// transfer queue, settings storage panel, ...). Extracted out of main.tsx
// so those domains do not need to import from main.tsx itself.
const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const sizeFormatters = new Map<string, { integer: Intl.NumberFormat; decimal: Intl.NumberFormat }>();

export const formatSize = (size: number, locale = "en-US") => {
  let value = size;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  let formatters = sizeFormatters.get(locale);
  if (!formatters) {
    formatters = {
      integer: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
      decimal: new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
    };
    sizeFormatters.set(locale, formatters);
  }
  const number = (unit === 0 ? formatters.integer : formatters.decimal).format(value);
  return `${number} ${SIZE_UNITS[unit]}`;
};

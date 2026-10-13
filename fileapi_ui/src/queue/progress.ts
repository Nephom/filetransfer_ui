export type QueueProgress = {
  completedBytes: number;
  totalBytes: number | null;
  percentage: number | null;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
  completedItems: number;
  totalItems: number;
  updatedAt: number;
};

export type ProgressSample = {
  bytes: number;
  at: number;
};

const MIN_SPEED_SAMPLE_MS = 300;
const progressFormatters = new Map<string, { integer: Intl.NumberFormat; decimal: Intl.NumberFormat }>();

const getProgressFormatters = (locale: string) => {
  let formatters = progressFormatters.get(locale);
  if (!formatters) {
    formatters = {
      integer: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
      decimal: new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
    };
    progressFormatters.set(locale, formatters);
  }
  return formatters;
};

export const initialQueueProgress = (totalItems = 1, totalBytes: number | null = null): QueueProgress => ({
  completedBytes: 0,
  totalBytes: totalBytes !== null && Number.isFinite(totalBytes) && totalBytes >= 0 ? totalBytes : null,
  percentage: totalBytes !== null && Number.isFinite(totalBytes) && totalBytes >= 0 ? 0 : null,
  bytesPerSecond: null,
  etaSeconds: null,
  completedItems: 0,
  totalItems,
  updatedAt: Date.now(),
});

export const updateQueueProgress = (
  previous: QueueProgress | undefined,
  completedBytes: number,
  totalBytes: number | null = previous?.totalBytes ?? null,
  completedItems = previous?.completedItems ?? 0,
  totalItems = previous?.totalItems ?? 1,
  sample: ProgressSample[] | undefined,
): QueueProgress => {
  const now = Date.now();
  const safeBytes = Number.isFinite(completedBytes) ? Math.max(0, completedBytes) : 0;
  const safeTotal = totalBytes !== null && Number.isFinite(totalBytes) && totalBytes >= 0 ? totalBytes : null;
  const samples = sample || [];
  const oldest = samples[0];
  const elapsed = oldest ? now - oldest.at : 0;
  const bytesPerSecond = oldest && elapsed >= MIN_SPEED_SAMPLE_MS
    ? Math.max(0, safeBytes - oldest.bytes) / (elapsed / 1000)
    : previous?.bytesPerSecond ?? null;
  const percentage = safeTotal === null
    ? null
    : safeTotal === 0
      ? (totalItems > 0 && completedItems >= totalItems ? 100 : 0)
      : Math.min(100, Math.max(0, (safeBytes / safeTotal) * 100));
  const etaSeconds = bytesPerSecond && bytesPerSecond > 0 && safeTotal !== null
    ? Math.max(0, (safeTotal - safeBytes) / bytesPerSecond)
    : null;

  return {
    completedBytes: safeBytes,
    totalBytes: safeTotal,
    percentage,
    bytesPerSecond,
    etaSeconds,
    completedItems,
    totalItems,
    updatedAt: now,
  };
};

export const formatQueueRate = (bytesPerSecond: number | null, locale = "en-US") => {
  if (!bytesPerSecond || bytesPerSecond < 1) return "--";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let value = bytesPerSecond;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const formatters = getProgressFormatters(locale);
  return `${(unit === 0 ? formatters.integer : formatters.decimal).format(value)} ${units[unit]}`;
};

export const formatQueueEta = (seconds: number | null, locale = "en-US") => {
  if (seconds === null || !Number.isFinite(seconds)) return "--";
  const rounded = Math.ceil(seconds);
  const integerFormatter = getProgressFormatters(locale).integer;
  const number = (value: number) => integerFormatter.format(value);
  if (rounded < 60) return `${number(rounded)}s`;
  const minutes = Math.floor(rounded / 60);
  const remainingSeconds = rounded % 60;
  return minutes < 60
    ? `${number(minutes)}m ${number(remainingSeconds)}s`
    : `${number(Math.floor(minutes / 60))}h ${number(minutes % 60)}m`;
};

export const formatQueueProgress = (progress: QueueProgress | undefined, locale = "en-US", etaLabel = "ETA") => {
  if (!progress) return "";
  const percentage = progress.percentage === null ? "" : ` (${Math.round(progress.percentage)}%)`;
  const rate = progress.bytesPerSecond === null ? "" : ` · ${formatQueueRate(progress.bytesPerSecond, locale)}`;
  const eta = progress.etaSeconds === null ? "" : ` · ${etaLabel} ${formatQueueEta(progress.etaSeconds, locale)}`;
  return `${percentage}${rate}${eta}`;
};

export const pruneQueueHistory = <T extends { status: string; finishedAt?: number }>(
  items: T[],
  now = Date.now(),
  limits: Record<string, { max: number; ttlMs: number }> = {
    completed: { max: 20, ttlMs: 24 * 60 * 60 * 1000 },
    cancelled: { max: 10, ttlMs: 24 * 60 * 60 * 1000 },
    failed: { max: 20, ttlMs: 7 * 24 * 60 * 60 * 1000 },
    needs_user_action: { max: 20, ttlMs: 7 * 24 * 60 * 60 * 1000 },
  },
) => {
  const terminal = new Map<string, T[]>();
  const active: T[] = [];
  for (const item of items) {
    const policy = limits[item.status];
    if (!policy) {
      active.push(item);
      continue;
    }
    const history = terminal.get(item.status) || [];
    history.push(item);
    terminal.set(item.status, history);
  }

  const retained = [...active];
  for (const [status, history] of terminal) {
    const policy = limits[status];
    retained.push(...history
      .sort((left, right) => (right.finishedAt || 0) - (left.finishedAt || 0))
      .filter((item, index) => index < policy.max && (!item.finishedAt || now - item.finishedAt < policy.ttlMs)));
  }
  return retained;
};

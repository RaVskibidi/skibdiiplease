const durationUnits = [
  { label: 'd', milliseconds: 86_400_000 },
  { label: 'h', milliseconds: 3_600_000 },
  { label: 'm', milliseconds: 60_000 },
  { label: 's', milliseconds: 1_000 },
] as const;

/**
 * Formats a millisecond duration into a compact, human-readable string.
 * Examples: 900 → 900ms, 65_000 → 1m 5s, 90_061_000 → 1d 1h 1m 1s.
 */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return '0ms';
  }

  if (milliseconds > 0 && milliseconds < 1_000) {
    return `${Math.round(milliseconds)}ms`;
  }

  let remaining = Math.floor(milliseconds);
  const parts: string[] = [];

  for (const unit of durationUnits) {
    const value = Math.floor(remaining / unit.milliseconds);
    if (value > 0) {
      parts.push(`${value}${unit.label}`);
      remaining -= value * unit.milliseconds;
    }
  }

  return parts.length > 0 ? parts.join(' ') : '0s';
}

/** Formats bytes using binary units with a stable one-decimal precision. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const precision = exponent === 0 ? 0 : 1;

  return `${value.toFixed(precision)} ${units[exponent]}`;
}

/** Truncates text without breaking the requested maximum length. */
export function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) {
    return '';
  }

  if (text.length <= maxLength) {
    return text;
  }

  if (maxLength === 1) {
    return '…';
  }

  return `${text.slice(0, maxLength - 1)}…`;
}

/** Formats a number with grouped thousands for embeds and logs. */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

/** Returns a Discord relative timestamp for a date or millisecond value. */
export function discordRelativeTimestamp(date: Date | number): string {
  const milliseconds = date instanceof Date ? date.getTime() : date;
  return `<t:${Math.floor(milliseconds / 1_000)}:R>`;
}

/** Returns a Discord full timestamp for a date or millisecond value. */
export function discordTimestamp(date: Date | number): string {
  const milliseconds = date instanceof Date ? date.getTime() : date;
  return `<t:${Math.floor(milliseconds / 1_000)}:F>`;
}

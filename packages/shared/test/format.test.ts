import { describe, expect, it } from 'vitest';

import {
  discordRelativeTimestamp,
  formatBytes,
  formatDuration,
  formatNumber,
  truncate,
} from '../src/format.js';

describe('formatDuration', () => {
  it('formats sub-second and zero values', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(900)).toBe('900ms');
    expect(formatDuration(-1)).toBe('0ms');
  });

  it('formats multiple units', () => {
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(90_061_000)).toBe('1d 1h 1m 1s');
  });
});

describe('formatBytes', () => {
  it('formats bytes using binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1_024)).toBe('1.0 KiB');
    expect(formatBytes(1_572_864)).toBe('1.5 MiB');
  });
});

describe('truncate', () => {
  it('preserves short strings and truncates long strings safely', () => {
    expect(truncate('T77 Security', 32)).toBe('T77 Security');
    expect(truncate('T77 Security', 8)).toBe('T77 Sec…');
    expect(truncate('T77', 0)).toBe('');
    expect(truncate('T77', 1)).toBe('…');
  });
});

describe('formatNumber', () => {
  it('groups thousands', () => {
    expect(formatNumber(1_000_000)).toBe('1,000,000');
  });
});

describe('Discord timestamps', () => {
  it('produces stable Discord timestamp markup', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(discordRelativeTimestamp(date)).toBe('<t:1767225600:R>');
    expect(discordRelativeTimestamp(date.getTime())).toBe('<t:1767225600:R>');
  });
});

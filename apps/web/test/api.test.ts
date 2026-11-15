import { describe, expect, it } from 'vitest';

import { formatDate, relativeTime } from '../src/api.js';

describe('formatDate', () => {
  it('returns a dash for missing or invalid values', () => {
    expect(formatDate(null)).toBe('-');
    expect(formatDate(undefined)).toBe('-');
    expect(formatDate('not-a-date')).toBe('-');
  });

  it('formats a valid ISO timestamp', () => {
    const formatted = formatDate('2026-01-01T12:30:00.000Z');
    expect(formatted).not.toBe('-');
    expect(formatted.length).toBeGreaterThan(0);
  });
});

describe('relativeTime', () => {
  it('returns a dash for missing values', () => {
    expect(relativeTime(null)).toBe('-');
    expect(relativeTime(undefined)).toBe('-');
  });

  it('describes future and past offsets', () => {
    const future = relativeTime(new Date(Date.now() + 2 * 86_400_000));
    const past = relativeTime(new Date(Date.now() - 3 * 3_600_000));

    expect(future).toMatch(/day/iu);
    expect(past).toMatch(/hour/iu);
  });
});

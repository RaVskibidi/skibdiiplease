import { describe, expect, it } from 'vitest';

import { getPublicErrorMessage, isT77Error, T77Error } from '../src/errors.js';

describe('T77Error', () => {
  it('preserves public error metadata', () => {
    const error = new T77Error('internal detail', {
      code: 'T77_PERMISSION_DENIED',
      userMessage: 'Denied.',
      meta: { guildId: '123' },
    });

    expect(isT77Error(error)).toBe(true);
    expect(error.code).toBe('T77_PERMISSION_DENIED');
    expect(error.userMessage).toBe('Denied.');
    expect(error.expose).toBe(true);
    expect(error.meta).toEqual({ guildId: '123' });
  });

  it('does not expose non-T77 errors', () => {
    expect(getPublicErrorMessage(new Error('secret detail'), 'Fallback')).toBe('Fallback');
  });

  it('does not expose hidden T77 errors', () => {
    const error = new T77Error('internal detail', {
      code: 'T77_INTERNAL',
      userMessage: 'Should stay hidden.',
      expose: false,
    });

    expect(getPublicErrorMessage(error, 'Fallback')).toBe('Fallback');
  });
});

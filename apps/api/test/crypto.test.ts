import { describe, expect, it } from 'vitest';

import {
  constantTimeEqual,
  jsonSafe,
  parseCookies,
  randomToken,
  serializeCookie,
  sha256,
  signPayload,
  TokenCipher,
  verifyPayload,
} from '../src/crypto.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('TokenCipher', () => {
  it('round-trips access and refresh tokens with distinct nonces', () => {
    const cipher = new TokenCipher(KEY);
    const access = cipher.encrypt('access-token-value');
    const refresh = cipher.encrypt('refresh-token-value');

    expect(access.iv).not.toBe(refresh.iv);
    expect(cipher.decrypt(access)).toBe('access-token-value');
    expect(cipher.decrypt(refresh)).toBe('refresh-token-value');
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => new TokenCipher(Buffer.alloc(16, 1).toString('base64'))).toThrow('32-byte key');
  });

  it('fails authentication when the ciphertext is tampered with', () => {
    const cipher = new TokenCipher(KEY);
    const value = cipher.encrypt('sensitive');
    const tampered = {
      ...value,
      ciphertext: Buffer.from('different').toString('base64'),
    };
    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  it('does not decrypt with a different key', () => {
    const value = new TokenCipher(KEY).encrypt('sensitive');
    expect(() => new TokenCipher(Buffer.alloc(32, 9).toString('base64')).decrypt(value)).toThrow();
  });
});

describe('signed payloads', () => {
  it('round-trips and rejects tampered bodies', () => {
    const token = signPayload({ state: 'abc', codeVerifier: 'verifier' }, 'secret');
    expect(verifyPayload<{ state: string }>(token, 'secret')).toEqual({
      state: 'abc',
      codeVerifier: 'verifier',
    });

    const [body] = token.split('.');
    expect(verifyPayload(`${body}.forged`, 'secret')).toBeNull();
    expect(verifyPayload(token, 'other-secret')).toBeNull();
    expect(verifyPayload('not-a-token', 'secret')).toBeNull();
  });
});

describe('cookie helpers', () => {
  it('parses multiple cookies and decodes values', () => {
    expect(parseCookies('t77_session=abc%3D; t77_csrf=def; empty=')).toEqual({
      t77_session: 'abc=',
      t77_csrf: 'def',
      empty: '',
    });
    expect(parseCookies(undefined)).toEqual({});
  });

  it('serializes HttpOnly cookies by default and allows the CSRF cookie to be readable', () => {
    const session = serializeCookie('t77_session', 'abc', { maxAgeSeconds: 60, secure: true });
    expect(session).toContain('HttpOnly');
    expect(session).toContain('Secure');
    expect(session).toContain('SameSite=Lax');
    expect(session).toContain('Max-Age=60');

    const csrf = serializeCookie('t77_csrf', 'abc', { httpOnly: false });
    expect(csrf).not.toContain('HttpOnly');
  });
});

describe('utility helpers', () => {
  it('compares strings without leaking length differences', () => {
    expect(constantTimeEqual('a', 'a')).toBe(true);
    expect(constantTimeEqual('a', 'b')).toBe(false);
    expect(constantTimeEqual('a', 'aa')).toBe(false);
  });

  it('produces hex digests and URL-safe random tokens', () => {
    expect(sha256('t77')).toMatch(/^[a-f0-9]{64}$/u);
    expect(randomToken(8)).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(randomToken(8)).not.toBe(randomToken(8));
  });

  it('serializes BigInt values for JSON responses', () => {
    const value = jsonSafe({ size: 123n });
    expect(value).toEqual({ size: '123' });
  });
});

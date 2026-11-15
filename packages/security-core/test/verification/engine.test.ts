import { describe, expect, it } from 'vitest';

import {
  CAPTCHA_ALPHABET,
  generateCaptcha,
  generateCode,
  hashAnswer,
  normalizeAnswer,
  renderCaptchaPng,
  verifyAnswer,
} from '../../src/verification/captcha.js';
import {
  DEFAULT_VERIFICATION_POLICY,
  evaluateVerificationAttempt,
  isChallengeExpired,
  type VerificationChallengeSnapshot,
} from '../../src/verification/engine.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function sequence(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index % values.length] ?? 0;
    index += 1;
    return value;
  };
}

function makeChallenge(
  overrides: Partial<VerificationChallengeSnapshot> = {},
): VerificationChallengeSnapshot {
  return {
    id: 'challenge-1',
    userId: '222222222222222222',
    mode: 'CAPTCHA',
    answerHash: hashAnswer('ABC234', 'fixed-salt'),
    attempts: 0,
    maxAttempts: 3,
    status: 'PENDING',
    expiresAt: new Date(NOW.getTime() + 300_000),
    createdAt: NOW,
    ...overrides,
  };
}

function makePng(): Buffer {
  return renderCaptchaPng('ABC234', { noise: 2, rng: sequence([0.1, 0.4, 0.7]) });
}

describe('CAPTCHA generation', () => {
  it('generates a code with the requested length from the safe alphabet', () => {
    const code = generateCode(6, sequence([0, 0.1, 0.2, 0.3, 0.4, 0.5]));
    expect(code).toHaveLength(6);
    for (const character of code) {
      expect(CAPTCHA_ALPHABET).toContain(character);
    }
  });

  it('clamps code length to a safe range', () => {
    expect(generateCode(1, () => 0)).toHaveLength(4);
    expect(generateCode(100, () => 0)).toHaveLength(10);
  });

  it('returns a real PNG signature and non-trivial payload', () => {
    const png = makePng();
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.length).toBeGreaterThan(500);
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
  });

  it('produces different images for different answers', () => {
    const first = renderCaptchaPng('AAAAAA', { noise: 0, rng: () => 0.5 });
    const second = renderCaptchaPng('BBBBBB', { noise: 0, rng: () => 0.5 });
    expect(first.equals(second)).toBe(false);
  });

  it('generates a code and image together without exposing the answer in metadata', () => {
    const result = generateCaptcha({ length: 5, rng: sequence([0.2, 0.4, 0.6]) });
    expect(result.code).toHaveLength(5);
    expect(result.png.subarray(0, 4).toString('hex')).toBe('89504e47');
  });

  it('hashes answers with a per-challenge salt and verifies case-insensitively', () => {
    const first = hashAnswer('abc234');
    const second = hashAnswer('abc234');
    expect(first).not.toBe(second);
    expect(first).toContain(':');
    expect(verifyAnswer(' abc 234 ', first)).toBe(true);
    expect(verifyAnswer('wrong', first)).toBe(false);
  });

  it('rejects malformed stored hashes instead of throwing', () => {
    expect(verifyAnswer('abc', 'not-a-hash')).toBe(false);
    expect(verifyAnswer('abc', 'salt:zzzz')).toBe(false);
  });

  it('normalises whitespace and case', () => {
    expect(normalizeAnswer(' a b  c ')).toBe('ABC');
  });
});

describe('verification engine', () => {
  it('passes a correct CAPTCHA answer', () => {
    const result = evaluateVerificationAttempt({
      challenge: makeChallenge(),
      answer: 'abc 234',
      now: NOW,
    });

    expect(result.outcome).toBe('PASSED');
    expect(result.nextStatus).toBe('PASSED');
    expect(result.attempts).toBe(0);
  });

  it('counts a wrong answer and allows a retry', () => {
    const result = evaluateVerificationAttempt({
      challenge: makeChallenge(),
      answer: 'wrong',
      now: NOW,
    });

    expect(result.outcome).toBe('FAILED');
    expect(result.terminal).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.remainingAttempts).toBe(2);
    expect(result.nextStatus).toBe('PENDING');
  });

  it('fails permanently when attempts are exhausted', () => {
    const result = evaluateVerificationAttempt({
      challenge: makeChallenge({ attempts: 2 }),
      answer: 'wrong',
      now: NOW,
    });

    expect(result.outcome).toBe('FAILED');
    expect(result.terminal).toBe(true);
    expect(result.remainingAttempts).toBe(0);
    expect(result.nextStatus).toBe('FAILED');
  });

  it('expires before checking the answer', () => {
    const result = evaluateVerificationAttempt({
      challenge: makeChallenge({ expiresAt: new Date(NOW.getTime() - 1) }),
      answer: 'ABC234',
      now: NOW,
    });

    expect(result.outcome).toBe('EXPIRED');
    expect(result.nextStatus).toBe('EXPIRED');
  });

  it('treats an already resolved challenge as terminal', () => {
    const result = evaluateVerificationAttempt({
      challenge: makeChallenge({ status: 'PASSED' }),
      answer: 'ABC234',
      now: NOW,
    });

    expect(result.outcome).toBe('ALREADY_RESOLVED');
    expect(result.terminal).toBe(true);
  });

  it('passes a BUTTON challenge without an answer', () => {
    const result = evaluateVerificationAttempt({
      challenge: makeChallenge({ mode: 'BUTTON', answerHash: '' }),
      now: NOW,
    });

    expect(result.outcome).toBe('PASSED');
  });

  it('reports expiration independently', () => {
    expect(isChallengeExpired(makeChallenge({ expiresAt: new Date(NOW.getTime() - 1) }), NOW)).toBe(
      true,
    );
    expect(isChallengeExpired(makeChallenge(), NOW)).toBe(false);
  });

  it('ships observation-safe verification defaults', () => {
    expect(DEFAULT_VERIFICATION_POLICY.enabled).toBe(false);
    expect(DEFAULT_VERIFICATION_POLICY.mode).toBe('BUTTON');
    expect(DEFAULT_VERIFICATION_POLICY.challengeLength).toBeGreaterThanOrEqual(4);
  });
});

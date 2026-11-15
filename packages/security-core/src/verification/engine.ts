import { verifyAnswer } from './captcha.js';

export type VerificationMode = 'BUTTON' | 'CAPTCHA';

export type VerificationChallengeStatus =
  'PENDING' | 'PASSED' | 'FAILED' | 'EXPIRED' | 'INVALIDATED';

export interface VerificationPolicy {
  readonly enabled: boolean;
  readonly mode: VerificationMode;
  readonly buttonFallbackEnabled: boolean;
  readonly challengeLength: number;
  readonly timeoutSeconds: number;
  readonly maxAttempts: number;
  readonly captchaNoise: number;
  readonly releaseQuarantineOnPass: boolean;
}

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = {
  enabled: false,
  mode: 'BUTTON',
  buttonFallbackEnabled: false,
  challengeLength: 6,
  timeoutSeconds: 300,
  maxAttempts: 3,
  captchaNoise: 3,
  releaseQuarantineOnPass: true,
};

export interface VerificationChallengeSnapshot {
  readonly id: string;
  readonly userId: string;
  readonly mode: VerificationMode;
  readonly answerHash: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly status: VerificationChallengeStatus;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export type VerificationOutcome =
  'PASSED' | 'FAILED' | 'EXPIRED' | 'INVALIDATED' | 'ALREADY_RESOLVED';

export interface VerificationAttemptResult {
  readonly outcome: VerificationOutcome;
  readonly terminal: boolean;
  readonly attempts: number;
  readonly remainingAttempts: number;
  readonly nextStatus: VerificationChallengeStatus;
}

/**
 * Evaluates a verification attempt against a stored challenge.
 *
 * The plaintext CAPTCHA answer is never stored or returned; only a salted scrypt
 * hash is persisted. Expiration is checked before the answer so an expired code
 * can never pass, and attempts are counted only for wrong answers.
 */
export function evaluateVerificationAttempt(input: {
  readonly challenge: VerificationChallengeSnapshot;
  readonly answer?: string;
  readonly now: Date;
}): VerificationAttemptResult {
  const { challenge, now } = input;

  if (challenge.status !== 'PENDING') {
    return {
      outcome: 'ALREADY_RESOLVED',
      terminal: true,
      attempts: challenge.attempts,
      remainingAttempts: Math.max(challenge.maxAttempts - challenge.attempts, 0),
      nextStatus: challenge.status,
    };
  }

  if (now.getTime() >= challenge.expiresAt.getTime()) {
    return {
      outcome: 'EXPIRED',
      terminal: true,
      attempts: challenge.attempts,
      remainingAttempts: 0,
      nextStatus: 'EXPIRED',
    };
  }

  if (challenge.mode === 'BUTTON') {
    return {
      outcome: 'PASSED',
      terminal: true,
      attempts: challenge.attempts,
      remainingAttempts: Math.max(challenge.maxAttempts - challenge.attempts, 0),
      nextStatus: 'PASSED',
    };
  }

  if (verifyAnswer(input.answer ?? '', challenge.answerHash)) {
    return {
      outcome: 'PASSED',
      terminal: true,
      attempts: challenge.attempts,
      remainingAttempts: Math.max(challenge.maxAttempts - challenge.attempts, 0),
      nextStatus: 'PASSED',
    };
  }

  const attempts = challenge.attempts + 1;
  const terminal = attempts >= challenge.maxAttempts;

  return {
    outcome: 'FAILED',
    terminal,
    attempts,
    remainingAttempts: Math.max(challenge.maxAttempts - attempts, 0),
    nextStatus: terminal ? 'FAILED' : 'PENDING',
  };
}

export function isChallengeExpired(challenge: VerificationChallengeSnapshot, now: Date): boolean {
  return challenge.status === 'PENDING' && now.getTime() >= challenge.expiresAt.getTime();
}

export function verificationPolicyFromConfig(config: {
  readonly enabled: boolean;
  readonly mode: VerificationMode;
  readonly buttonFallbackEnabled: boolean;
  readonly challengeLength: number;
  readonly timeoutSeconds: number;
  readonly maxAttempts: number;
  readonly captchaNoise: number;
  readonly releaseQuarantineOnPass: boolean;
}): VerificationPolicy {
  return {
    enabled: config.enabled,
    mode: config.mode,
    buttonFallbackEnabled: config.buttonFallbackEnabled,
    challengeLength: config.challengeLength,
    timeoutSeconds: config.timeoutSeconds,
    maxAttempts: config.maxAttempts,
    captchaNoise: config.captchaNoise,
    releaseQuarantineOnPass: config.releaseQuarantineOnPass,
  };
}

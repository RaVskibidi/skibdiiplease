export const MAX_TIMEOUT_SECONDS = 28 * 24 * 60 * 60;
export const MAX_TEMPORARY_WHITELIST_SECONDS = 365 * 24 * 60 * 60;

export interface ParsedDuration {
  readonly seconds: number;
  readonly normalised: string;
}

const UNIT_SECONDS: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
  w: 604_800,
};

/**
 * Parses compact durations such as `30m`, `12h`, `7d`, or `2w`.
 * Bare integers are interpreted as seconds. Returns null for invalid input.
 */
export function parseDuration(input: string): ParsedDuration | null {
  const match = /^(\d{1,9})\s*([smhdw])?$/iu.exec(input.trim());
  if (match === null) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  const factor = UNIT_SECONDS[unit];
  if (factor === undefined || amount <= 0) {
    return null;
  }

  const seconds = amount * factor;
  if (!Number.isSafeInteger(seconds)) {
    return null;
  }

  return { seconds, normalised: `${amount}${unit}` };
}

export interface TimeoutDurationCheck {
  readonly valid: boolean;
  readonly reason?: 'TOO_SHORT' | 'TOO_LONG' | 'INVALID';
  readonly seconds: number;
}

export function validateTimeoutDuration(seconds: number): TimeoutDurationCheck {
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds <= 0) {
    return { valid: false, reason: 'INVALID', seconds: 0 };
  }
  if (seconds < 60) {
    return { valid: false, reason: 'TOO_SHORT', seconds };
  }
  if (seconds > MAX_TIMEOUT_SECONDS) {
    return { valid: false, reason: 'TOO_LONG', seconds };
  }
  return { valid: true, seconds };
}

export interface WarningEscalationPolicy {
  /** Active warning count at which T77 suggests a timeout. */
  readonly timeoutAtWarnings: number;
  /** Active warning count at which T77 suggests a kick. */
  readonly kickAtWarnings: number;
  /** Active warning count at which T77 suggests a ban. */
  readonly banAtWarnings: number;
}

export const DEFAULT_WARNING_ESCALATION: WarningEscalationPolicy = {
  timeoutAtWarnings: 3,
  kickAtWarnings: 5,
  banAtWarnings: 7,
};

export type WarningEscalation = 'NONE' | 'TIMEOUT' | 'KICK' | 'BAN';

/**
 * Computes an advisory escalation only. T77 never applies it automatically;
 * the caller must show it to a moderator.
 */
export function warningEscalation(
  activeWarnings: number,
  policy: WarningEscalationPolicy = DEFAULT_WARNING_ESCALATION,
): WarningEscalation {
  if (!Number.isInteger(activeWarnings) || activeWarnings < 0) {
    return 'NONE';
  }
  if (activeWarnings >= policy.banAtWarnings) {
    return 'BAN';
  }
  if (activeWarnings >= policy.kickAtWarnings) {
    return 'KICK';
  }
  if (activeWarnings >= policy.timeoutAtWarnings) {
    return 'TIMEOUT';
  }
  return 'NONE';
}

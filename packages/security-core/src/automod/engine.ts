import {
  DEFAULT_AUTOMOD_POLICY,
  type AutomodDecision,
  type AutomodEvaluationInput,
  type AutomodPolicy,
  type AutomodRule,
  type AutomodSignal,
} from './types.js';

const INVITE_PATTERN = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/iu;
const LINK_PATTERN = /(?:https?:\/\/|www\.)[^\s<>]+/giu;
const UPPERCASE_PATTERN = /\p{Lu}/gu;
const LETTER_PATTERN = /\p{L}/gu;

const SIGNAL_WEIGHTS: Record<AutomodRule, number> = {
  FLOOD: 40,
  DUPLICATE: 30,
  MENTION_SPAM: 40,
  EXCESSIVE_CAPS: 15,
  INVITE_LINK: 45,
  BLOCKED_LINK: 45,
  BLOCKED_WORD: 50,
  EVERYONE_MENTION: 35,
};

/**
 * Evaluates one message against a guild's AutoMod policy.
 *
 * Safety invariants:
 *  - the module and every Discord response are disabled by default;
 *  - a single message can never time out unless the owner explicitly marks a
 *    matching rule as high-confidence;
 *  - observe mode records evidence but performs no deletion, warning, or timeout;
 *  - role, channel, user, staff, whitelist, and owner exemptions are checked
 *    before detection so an exempt member is never scored;
 *  - duplicate and caps checks normalise text, avoiding trivial punctuation or
 *    whitespace false positives.
 */
export function evaluateMessage(
  input: AutomodEvaluationInput,
  now: Date = new Date(),
): AutomodDecision {
  const { message, policy, exemption } = input;
  const base = {
    messageId: message.id,
    userId: message.userId,
    channelId: message.channelId,
    warningCount: input.warningCount,
    warningCountAfter: input.warningCount,
    signals: [] as readonly AutomodSignal[],
    score: 0,
    highConfidence: false,
    recommendedAction: 'NONE' as const,
    effectiveAction: 'NONE' as const,
    deleteMessage: false,
    warn: false,
    timeoutSeconds: null,
  };

  const blocked = exemptionReason(message, policy, exemption);
  if (blocked !== null) {
    return { ...base, matched: false, blockedReason: blocked };
  }

  if (!policy.enabled) {
    return { ...base, matched: false, blockedReason: 'AUTOMOD_DISABLED' };
  }

  const signals = collectSignals(input, now);
  if (signals.length === 0) {
    return { ...base, matched: false, blockedReason: 'NO_MATCH' };
  }

  const score = Math.min(
    100,
    signals.reduce((total, signal) => total + signal.weight, 0),
  );
  const highConfidence = signals.some((signal) => signal.highConfidence);

  let recommendedAction: AutomodDecision['recommendedAction'] = 'NONE';
  if (
    policy.timeoutEnabled &&
    (highConfidence || input.warningCount + 1 >= policy.timeoutAfterWarnings)
  ) {
    recommendedAction = 'TIMEOUT';
  } else if (policy.warnEnabled) {
    recommendedAction = 'WARN';
  }

  // A first-message timeout requires an explicitly configured high-confidence rule.
  if (recommendedAction === 'TIMEOUT' && input.warningCount === 0 && !highConfidence) {
    return {
      ...base,
      matched: true,
      signals,
      score,
      highConfidence,
      recommendedAction: 'TIMEOUT',
      blockedReason: 'SINGLE_MESSAGE_TIMEOUT_BLOCKED',
    };
  }

  if (input.automationMode === 'OBSERVE') {
    return {
      ...base,
      matched: true,
      signals,
      score,
      highConfidence,
      recommendedAction,
      blockedReason: 'OBSERVE_MODE',
    };
  }

  if (!input.enforcementApproved) {
    return {
      ...base,
      matched: true,
      signals,
      score,
      highConfidence,
      recommendedAction,
      blockedReason: 'OWNER_APPROVAL_REQUIRED',
    };
  }

  const deleteMessage = policy.deleteOffendingMessage;

  if (recommendedAction === 'NONE') {
    return {
      ...base,
      matched: true,
      signals,
      score,
      highConfidence,
      recommendedAction,
      deleteMessage,
      blockedReason: 'NO_ACTION_CONFIGURED',
    };
  }

  return {
    ...base,
    matched: true,
    signals,
    score,
    highConfidence,
    recommendedAction,
    effectiveAction: recommendedAction,
    deleteMessage,
    warn: recommendedAction === 'WARN',
    timeoutSeconds: recommendedAction === 'TIMEOUT' ? policy.timeoutSeconds : null,
    warningCountAfter: recommendedAction === 'WARN' ? input.warningCount + 1 : input.warningCount,
    blockedReason: null,
  };
}

export function normalizePolicy(policy: AutomodPolicy): AutomodPolicy {
  return { ...DEFAULT_AUTOMOD_POLICY, ...policy };
}

function exemptionReason(
  message: AutomodEvaluationInput['message'],
  policy: AutomodPolicy,
  exemption: AutomodEvaluationInput['exemption'],
): AutomodDecision['blockedReason'] {
  if (message.isBot) {
    return 'BOT_AUTHOR';
  }
  if (exemption.isOwner) {
    return 'OWNER';
  }
  if (exemption.isWhitelistedUser) {
    return 'WHITELISTED';
  }
  if (exemption.isExemptChannel || policy.exemptChannelIds.includes(message.channelId)) {
    return 'EXEMPT_CHANNEL';
  }
  if (
    exemption.isExemptRole ||
    message.roleIds.some((roleId) => policy.exemptRoleIds.includes(roleId))
  ) {
    return 'EXEMPT_ROLE';
  }
  if (exemption.isExemptUser || policy.exemptUserIds.includes(message.userId)) {
    return 'EXEMPT_USER';
  }
  if (exemption.isAuthorizedStaff || (policy.ignoreStaff && message.isStaff)) {
    return 'STAFF';
  }
  return null;
}

function collectSignals(input: AutomodEvaluationInput, now: Date): AutomodSignal[] {
  const { message, policy } = input;
  const signals: AutomodSignal[] = [];
  const highConfidence = (rule: AutomodRule) => policy.highConfidenceRules.includes(rule);
  const add = (rule: AutomodRule, detail: string) => {
    signals.push({
      rule,
      weight: SIGNAL_WEIGHTS[rule],
      detail,
      highConfidence: highConfidence(rule),
    });
  };

  const floodCutoff = now.getTime() - policy.floodWindowSeconds * 1_000;
  const floodCount =
    input.recentMessages.filter((entry) => entry.createdAt.getTime() >= floodCutoff).length + 1;
  if (floodCount >= policy.floodMessages) {
    add('FLOOD', `${floodCount} messages in ${policy.floodWindowSeconds}s`);
  }

  const duplicateCutoff = now.getTime() - policy.duplicateWindowSeconds * 1_000;
  const normalized = normalizeMessage(message.content);
  if (normalized.length > 0) {
    const duplicates =
      input.recentMessages.filter(
        (entry) =>
          entry.createdAt.getTime() >= duplicateCutoff &&
          normalizeMessage(entry.content) === normalized,
      ).length + 1;

    if (duplicates >= policy.duplicateThreshold) {
      add('DUPLICATE', `${duplicates} identical messages in ${policy.duplicateWindowSeconds}s`);
    }
  }

  if (message.mentionCount >= policy.mentionLimit) {
    add('MENTION_SPAM', `${message.mentionCount} mentions in one message`);
  }

  if (message.mentionsEveryone) {
    add('EVERYONE_MENTION', '@everyone or @here mention');
  }

  if (hasExcessiveCaps(message.content, policy)) {
    const letters = message.content.match(LETTER_PATTERN)?.length ?? 0;
    const uppercase = message.content.match(UPPERCASE_PATTERN)?.length ?? 0;
    add(
      'EXCESSIVE_CAPS',
      `${Math.round((uppercase / Math.max(letters, 1)) * 100)}% uppercase across ${letters} letters`,
    );
  }

  if (policy.inviteLinksBlocked && INVITE_PATTERN.test(message.content)) {
    add('INVITE_LINK', 'Discord invite link');
  }

  if (policy.linkFilterEnabled) {
    const blockedHost = findBlockedHost(message.content, policy.blockedDomains);
    if (blockedHost !== null) {
      add('BLOCKED_LINK', `Blocked domain: ${blockedHost}`);
    }
  }

  const blockedWord = findBlockedWord(message.content, policy.bannedWords);
  if (blockedWord !== null) {
    add('BLOCKED_WORD', 'Matched a configured blocked word');
  }

  return signals;
}

function hasExcessiveCaps(content: string, policy: AutomodPolicy): boolean {
  if (content.trim().length < policy.capsMinimumLength) {
    return false;
  }

  const letters = content.match(LETTER_PATTERN)?.length ?? 0;
  if (letters < Math.min(policy.capsMinimumLength, 8)) {
    return false;
  }

  const uppercase = content.match(UPPERCASE_PATTERN)?.length ?? 0;
  return (uppercase / letters) * 100 >= policy.capsPercentage;
}

/** Normalises text for duplicate detection without echoing it into logs. */
export function normalizeMessage(content: string): string {
  return content
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function findBlockedHost(content: string, blockedDomains: readonly string[]): string | null {
  if (blockedDomains.length === 0) {
    return null;
  }

  const domains = blockedDomains.map((domain) => domain.trim().toLowerCase()).filter(Boolean);
  if (domains.length === 0) {
    return null;
  }

  for (const match of content.matchAll(LINK_PATTERN)) {
    const candidate = match[0];
    const withScheme = /^https?:\/\//iu.test(candidate) ? candidate : `https://${candidate}`;

    try {
      const host = new URL(withScheme).hostname.replace(/^www\./iu, '').toLowerCase();
      const blocked = domains.find((domain) => host === domain || host.endsWith(`.${domain}`));
      if (blocked !== undefined) {
        return blocked;
      }
    } catch {
      // A malformed link is not evidence of a blocked domain.
    }
  }

  return null;
}

function findBlockedWord(content: string, bannedWords: readonly string[]): string | null {
  const normalized = content.normalize('NFKC').toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  for (const word of bannedWords) {
    const candidate = word.trim().toLowerCase();
    if (candidate.length === 0) {
      continue;
    }

    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u');
    if (pattern.test(normalized)) {
      return candidate;
    }
  }

  return null;
}

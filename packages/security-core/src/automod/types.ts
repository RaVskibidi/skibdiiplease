/** AutoMod signal identifiers. Each observation is independent evidence. */
export type AutomodRule =
  | 'FLOOD'
  | 'DUPLICATE'
  | 'MENTION_SPAM'
  | 'EXCESSIVE_CAPS'
  | 'INVITE_LINK'
  | 'BLOCKED_LINK'
  | 'BLOCKED_WORD'
  | 'EVERYONE_MENTION';

export const AUTOMOD_RULES: readonly AutomodRule[] = [
  'FLOOD',
  'DUPLICATE',
  'MENTION_SPAM',
  'EXCESSIVE_CAPS',
  'INVITE_LINK',
  'BLOCKED_LINK',
  'BLOCKED_WORD',
  'EVERYONE_MENTION',
];

export interface AutomodPolicy {
  readonly enabled: boolean;
  readonly floodMessages: number;
  readonly floodWindowSeconds: number;
  readonly duplicateWindowSeconds: number;
  /** Total identical messages (including the current one) that constitute repetition. */
  readonly duplicateThreshold: number;
  readonly mentionLimit: number;
  readonly capsPercentage: number;
  readonly capsMinimumLength: number;
  readonly inviteLinksBlocked: boolean;
  readonly linkFilterEnabled: boolean;
  readonly blockedDomains: readonly string[];
  readonly bannedWords: readonly string[];
  readonly exemptChannelIds: readonly string[];
  readonly exemptRoleIds: readonly string[];
  readonly exemptUserIds: readonly string[];
  readonly ignoreStaff: boolean;
  readonly warnEnabled: boolean;
  readonly timeoutEnabled: boolean;
  readonly timeoutAfterWarnings: number;
  readonly deleteOffendingMessage: boolean;
  /**
   * Rules an owner explicitly trusts enough to act on a single message.
   * Empty by default, so one message never produces an automatic timeout.
   */
  readonly highConfidenceRules: readonly AutomodRule[];
  readonly timeoutSeconds: number;
}

/**
 * Observation-safe defaults. The module itself starts disabled; once enabled,
 * warnings are the default response and a first-message timeout is impossible
 * until an owner explicitly marks a rule high-confidence.
 */
export const DEFAULT_AUTOMOD_POLICY: AutomodPolicy = {
  enabled: true,
  floodMessages: 8,
  floodWindowSeconds: 10,
  duplicateWindowSeconds: 60,
  duplicateThreshold: 3,
  mentionLimit: 6,
  capsPercentage: 70,
  capsMinimumLength: 20,
  inviteLinksBlocked: true,
  linkFilterEnabled: true,
  blockedDomains: [],
  bannedWords: [],
  exemptChannelIds: [],
  exemptRoleIds: [],
  exemptUserIds: [],
  ignoreStaff: true,
  warnEnabled: true,
  timeoutEnabled: true,
  timeoutAfterWarnings: 3,
  deleteOffendingMessage: true,
  highConfidenceRules: [],
  timeoutSeconds: 600,
};

export interface AutomodMessageSnapshot {
  readonly id: string;
  readonly channelId: string;
  readonly userId: string;
  readonly content: string;
  readonly createdAt: Date;
  readonly mentionCount: number;
  readonly roleMentionCount: number;
  readonly mentionsEveryone: boolean;
  readonly isBot: boolean;
  readonly isStaff: boolean;
  readonly roleIds: readonly string[];
}

export interface AutomodPriorMessage {
  readonly id: string;
  readonly content: string;
  readonly createdAt: Date;
}

export interface AutomodExemption {
  readonly isOwner: boolean;
  readonly isWhitelistedUser: boolean;
  readonly isAuthorizedStaff: boolean;
  readonly isExemptChannel: boolean;
  readonly isExemptRole: boolean;
  readonly isExemptUser: boolean;
}

export interface AutomodEvaluationInput {
  readonly message: AutomodMessageSnapshot;
  readonly policy: AutomodPolicy;
  readonly automationMode: 'OBSERVE' | 'ENFORCE_REVERSIBLE' | 'ENFORCE_DESTRUCTIVE';
  readonly enforcementApproved: boolean;
  readonly recentMessages: readonly AutomodPriorMessage[];
  /** Warnings already issued to this member in the policy window. */
  readonly warningCount: number;
  readonly exemption: AutomodExemption;
}

export interface AutomodSignal {
  readonly rule: AutomodRule;
  readonly weight: number;
  readonly detail: string;
  readonly highConfidence: boolean;
}

export type AutomodAction = 'NONE' | 'WARN' | 'TIMEOUT';

export type AutomodBlockedReason =
  | 'AUTOMOD_DISABLED'
  | 'BOT_AUTHOR'
  | 'OWNER'
  | 'WHITELISTED'
  | 'EXEMPT_CHANNEL'
  | 'EXEMPT_ROLE'
  | 'EXEMPT_USER'
  | 'STAFF'
  | 'NO_MATCH'
  | 'SINGLE_MESSAGE_TIMEOUT_BLOCKED'
  | 'NO_ACTION_CONFIGURED'
  | 'OBSERVE_MODE'
  | 'OWNER_APPROVAL_REQUIRED';

export interface AutomodDecision {
  readonly messageId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly matched: boolean;
  readonly signals: readonly AutomodSignal[];
  readonly score: number;
  readonly highConfidence: boolean;
  readonly recommendedAction: AutomodAction;
  readonly effectiveAction: AutomodAction;
  readonly deleteMessage: boolean;
  readonly warn: boolean;
  readonly timeoutSeconds: number | null;
  readonly warningCount: number;
  readonly warningCountAfter: number;
  readonly blockedReason: AutomodBlockedReason | null;
}

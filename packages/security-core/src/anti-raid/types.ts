/** Raid signals are independent observations, not a verdict. */
export type RaidSignal =
  | 'JOIN_VELOCITY'
  | 'YOUNG_ACCOUNT'
  | 'NO_AVATAR'
  | 'SIMILAR_ACCOUNT_AGE'
  | 'SUSPICIOUS_USERNAME'
  | 'BOT_ACCOUNT';

export interface RaidSignalDetail {
  readonly signal: RaidSignal;
  readonly weight: number;
  readonly detail: string;
}

export interface RaidJoinRecord {
  readonly userId: string;
  readonly joinedAt: Date;
  readonly accountCreatedAt: Date;
  readonly hasAvatar: boolean;
  readonly isBot: boolean;
  readonly username?: string;
}

export interface AntiRaidPolicy {
  readonly enabled: boolean;
  readonly joinWindowSeconds: number;
  /** Number of joins inside the window that constitutes a velocity burst. */
  readonly aggregateThreshold: number;
  /** Independent signals required before any containment. */
  readonly minimumSignals: number;
  readonly minimumAccountAgeDays: number;
  readonly riskThreshold: number;
  readonly quarantineEnabled: boolean;
  readonly lockdownEnabled: boolean;
  readonly autoBanEnabled: boolean;
  readonly verificationRequired: boolean;
  readonly bypassBadges: readonly string[];
  readonly velocityWeight: number;
  readonly accountAgeWeight: number;
  readonly avatarWeight: number;
  readonly similarAgeWeight: number;
  readonly suspiciousNameWeight: number;
}

export type RaidAction = 'ALERT' | 'QUARANTINE' | 'BAN';

export type RaidBlockedReason =
  | 'RAID_DISABLED'
  | 'THRESHOLD_NOT_MET'
  | 'INSUFFICIENT_SIGNALS'
  | 'ACCOUNT_AGE_ONLY'
  | 'WHITELISTED'
  | 'OBSERVE_MODE'
  | 'OWNER_APPROVAL_REQUIRED'
  | 'AUTO_BAN_DISABLED'
  | 'QUARANTINE_DISABLED'
  | 'BOT_ACCOUNT';

export interface RaidExemption {
  readonly isOwner: boolean;
  readonly isWhitelistedUser: boolean;
  readonly isAuthorizedStaff: boolean;
  readonly bypassesRaidChecks: boolean;
}

export interface RaidEvaluationInput {
  readonly join: RaidJoinRecord;
  readonly recentJoins: readonly RaidJoinRecord[];
  readonly policy: AntiRaidPolicy;
  readonly automationMode: 'OBSERVE' | 'ENFORCE_REVERSIBLE' | 'ENFORCE_DESTRUCTIVE';
  readonly enforcementApproved: boolean;
  readonly exemption: RaidExemption;
}

export interface RaidDecision {
  readonly userId: string;
  readonly score: number;
  readonly signals: readonly RaidSignalDetail[];
  readonly recentJoinCount: number;
  readonly raidActive: boolean;
  readonly recommendedAction: RaidAction;
  readonly effectiveAction: RaidAction | null;
  /** Lockdown is advisory until an operator confirms; T77 never closes a guild automatically. */
  readonly lockdownRecommended: boolean;
  readonly blockedReason: RaidBlockedReason | null;
  readonly wouldHaveActed: boolean;
  readonly requiresVerification: boolean;
  readonly shouldAlert: boolean;
  readonly shouldOpenIncident: boolean;
}

export const DEFAULT_ANTI_RAID_POLICY: AntiRaidPolicy = {
  enabled: true,
  joinWindowSeconds: 60,
  aggregateThreshold: 10,
  minimumSignals: 2,
  minimumAccountAgeDays: 7,
  riskThreshold: 60,
  quarantineEnabled: true,
  lockdownEnabled: false,
  autoBanEnabled: false,
  verificationRequired: true,
  bypassBadges: [],
  velocityWeight: 30,
  accountAgeWeight: 25,
  avatarWeight: 15,
  similarAgeWeight: 20,
  suspiciousNameWeight: 15,
};

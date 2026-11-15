import type {
  AntiNukeAction,
  AttributionConfidence,
  AutomationMode,
  IncidentSeverity,
  IncidentType,
  PunishmentType,
  SecurityEventSource,
} from './actions.js';

/** Normalized, Discord-independent security event consumed by the engine. */
export interface NormalizedSecurityAction {
  readonly eventId: string;
  readonly guildId: string;
  readonly action: AntiNukeAction;
  readonly actorId: string | null;
  readonly targetId: string | null;
  /** When the action actually happened according to Discord, not when T77 received it. */
  readonly occurredAt: Date;
  readonly source: SecurityEventSource;
  readonly attribution: AttributionConfidence;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AntiNukeRuleConfig {
  readonly action: AntiNukeAction;
  readonly enabled: boolean;
  readonly threshold: number;
  readonly windowSeconds: number;
  readonly containment: PunishmentType;
  readonly requiresDestructiveApproval: boolean;
  readonly cooldownSeconds: number;
}

export interface RuleSeed {
  readonly action: AntiNukeAction;
  readonly enabled: boolean;
  readonly threshold: number;
  readonly windowSeconds: number;
  readonly containment: PunishmentType;
  readonly requiresDestructiveApproval: boolean;
  readonly cooldownSeconds: number;
}

export interface WhitelistFlags {
  readonly globalUser: boolean;
  readonly actionUser: boolean;
  readonly globalRole: boolean;
  readonly actionRole: boolean;
  /** Only applies when the action has a channel target. */
  readonly targetChannel: boolean;
}

export interface ActorAuthorization {
  readonly actorId: string | null;
  readonly isOwner: boolean;
  readonly isSelf: boolean;
  readonly isBot: boolean;
  readonly actorRolePosition: number | null;
  readonly botRolePosition: number | null;
  readonly whitelist: WhitelistFlags;
  /** Explicit T77 staff grant; never bypasses audit logging or hierarchy. */
  readonly isAuthorizedStaff: boolean;
  /** Whether the target bot is explicitly approved for BOT_ADD. */
  readonly targetBotApproved: boolean;
  /** Recorded owner approval for non-observation automation. */
  readonly enforcementApproved: boolean;
}

export interface AntiNukeEvaluationInput {
  readonly event: NormalizedSecurityAction;
  readonly rule: AntiNukeRuleConfig;
  readonly authorization: ActorAuthorization;
  readonly automationMode: AutomationMode;
}

export type ExemptionReason =
  | 'RULE_DISABLED'
  | 'SELF_ACTION'
  | 'SERVER_OWNER'
  | 'GLOBAL_USER_WHITELIST'
  | 'ACTION_USER_WHITELIST'
  | 'GLOBAL_ROLE_WHITELIST'
  | 'ACTION_ROLE_WHITELIST'
  | 'TARGET_CHANNEL_WHITELIST'
  | 'AUTHORIZED_STAFF'
  | 'APPROVED_BOT';

export type ResponseBlockReason =
  | 'THRESHOLD_NOT_MET'
  | 'ALERT_ONLY'
  | 'UNCERTAIN_ATTRIBUTION'
  | 'INSUFFICIENT_EVENTS'
  | 'HIERARCHY'
  | 'COOLDOWN_ACTIVE'
  | 'OBSERVE_MODE'
  | 'REVERSIBLE_MODE_REQUIRED'
  | 'DESTRUCTIVE_MODE_REQUIRED'
  | 'OWNER_APPROVAL_REQUIRED';

export interface AntiNukeDecision {
  readonly eventId: string;
  readonly guildId: string;
  readonly action: AntiNukeAction;
  readonly actorId: string | null;
  readonly targetId: string | null;
  readonly occurredAt: Date;
  readonly incidentType: IncidentType;
  readonly counted: boolean;
  readonly exemption: ExemptionReason | null;
  readonly count: number;
  readonly threshold: number;
  readonly windowSeconds: number;
  readonly riskScore: number;
  readonly severity: IncidentSeverity;
  readonly thresholdExceeded: boolean;
  readonly attribution: AttributionConfidence;
  readonly recommendedContainment: PunishmentType;
  readonly effectiveContainment: PunishmentType | null;
  readonly blockedReason: ResponseBlockReason | null;
  /** True when the engine would have contained the actor but policy prevented it. */
  readonly wouldHaveActed: boolean;
  readonly shouldAlert: boolean;
  readonly shouldOpenIncident: boolean;
}

export interface AntiNukeEngineOptions {
  /** Decayed per-actor risk horizon. */
  readonly riskWindowSeconds?: number;
  /** Absolute minimum number of certain events before automatic containment. */
  readonly minimumEventsForEnforcement?: number;
  /** Global per-actor response cooldown, applied across all actions. */
  readonly actorResponseCooldownSeconds?: number;
  /** Bounds memory use if a guild sees pathological traffic. */
  readonly maxTrackedActors?: number;
  readonly clock?: () => Date;
}

export interface AntiNukeRiskEntry {
  readonly at: number;
  readonly weight: number;
}

/**
 * Durable rolling-window counters.
 *
 * T77's production path stores these in Redis, so counters survive a restart and
 * are shared across shards. The engine still supports an in-memory path for
 * deterministic unit tests.
 */
export interface AntiNukeCounterSnapshot {
  readonly windowTimestamps: readonly number[];
  readonly riskEntries: readonly AntiNukeRiskEntry[];
  readonly cooldownActive: boolean;
}

export interface AntiNukeCounterRecordInput {
  readonly guildId: string;
  readonly actorId: string;
  readonly action: AntiNukeAction;
  readonly eventId: string;
  readonly occurredAt: number;
  readonly now: number;
  readonly windowSeconds: number;
  readonly riskWindowSeconds: number;
  readonly riskWeight: number;
  readonly cooldownSeconds: number;
  readonly actorCooldownSeconds: number;
}

export interface AntiNukeEnforcementInput {
  readonly guildId: string;
  readonly actorId: string;
  readonly action: AntiNukeAction;
  readonly now: number;
  readonly cooldownSeconds: number;
  readonly actorCooldownSeconds: number;
}

export interface AntiNukeCounterStore {
  /** Atomically prunes, records, and reads the actor's counters. */
  record(input: AntiNukeCounterRecordInput): Promise<AntiNukeCounterSnapshot>;
  /** Records that a containment was actually applied. */
  recordEnforcement(input: AntiNukeEnforcementInput): Promise<void>;
}

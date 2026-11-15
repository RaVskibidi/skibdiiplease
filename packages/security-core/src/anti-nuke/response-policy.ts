import {
  DESTRUCTIVE_PUNISHMENTS,
  type AutomationMode,
  type AttributionConfidence,
  type PunishmentType,
} from './actions.js';
import type { ResponseBlockReason } from './types.js';

export interface ResponsePolicyInput {
  readonly automationMode: AutomationMode;
  readonly containment: PunishmentType;
  readonly requiresDestructiveApproval: boolean;
  readonly enforcementApproved: boolean;
  readonly eventCount: number;
  readonly thresholdExceeded: boolean;
  readonly attribution: AttributionConfidence;
  readonly hierarchyBlocked: boolean;
  readonly cooldownActive: boolean;
  readonly minimumEventsForEnforcement: number;
}

export interface ResponsePolicyResult {
  readonly effectiveContainment: PunishmentType | null;
  readonly blockedReason: ResponseBlockReason | null;
  readonly wouldHaveActed: boolean;
}

/**
 * Decides whether a threshold crossing may become a real Discord action.
 *
 * Safety invariants:
 *  - alert-only rules never produce an action;
 *  - one event is never enough;
 *  - uncertain attribution is never enough;
 *  - hierarchy is a hard stop;
 *  - observation mode records intent but performs nothing;
 *  - destructive actions need both destructive mode and recorded owner approval.
 */
export function resolveResponsePolicy(input: ResponsePolicyInput): ResponsePolicyResult {
  const actionable =
    input.thresholdExceeded &&
    input.containment !== 'ALERT' &&
    input.attribution === 'CERTAIN' &&
    input.eventCount >= input.minimumEventsForEnforcement &&
    !input.hierarchyBlocked;

  if (!input.thresholdExceeded) {
    return {
      effectiveContainment: null,
      blockedReason: 'THRESHOLD_NOT_MET',
      wouldHaveActed: false,
    };
  }

  if (input.containment === 'ALERT') {
    return { effectiveContainment: null, blockedReason: 'ALERT_ONLY', wouldHaveActed: false };
  }

  if (input.attribution !== 'CERTAIN') {
    return {
      effectiveContainment: null,
      blockedReason: 'UNCERTAIN_ATTRIBUTION',
      wouldHaveActed: false,
    };
  }

  if (input.eventCount < input.minimumEventsForEnforcement) {
    return {
      effectiveContainment: null,
      blockedReason: 'INSUFFICIENT_EVENTS',
      wouldHaveActed: false,
    };
  }

  if (input.hierarchyBlocked) {
    return { effectiveContainment: null, blockedReason: 'HIERARCHY', wouldHaveActed: false };
  }

  if (input.cooldownActive) {
    return {
      effectiveContainment: null,
      blockedReason: 'COOLDOWN_ACTIVE',
      wouldHaveActed: actionable,
    };
  }

  if (input.automationMode === 'OBSERVE') {
    return {
      effectiveContainment: null,
      blockedReason: 'OBSERVE_MODE',
      wouldHaveActed: actionable,
    };
  }

  if (!input.enforcementApproved) {
    return {
      effectiveContainment: null,
      blockedReason: 'OWNER_APPROVAL_REQUIRED',
      wouldHaveActed: actionable,
    };
  }

  const destructive = DESTRUCTIVE_PUNISHMENTS.has(input.containment);

  if (destructive) {
    if (input.automationMode !== 'ENFORCE_DESTRUCTIVE') {
      return {
        effectiveContainment: null,
        blockedReason: 'DESTRUCTIVE_MODE_REQUIRED',
        wouldHaveActed: actionable,
      };
    }

    if (input.requiresDestructiveApproval && !input.enforcementApproved) {
      return {
        effectiveContainment: null,
        blockedReason: 'OWNER_APPROVAL_REQUIRED',
        wouldHaveActed: actionable,
      };
    }
  }

  return {
    effectiveContainment: input.containment,
    blockedReason: null,
    wouldHaveActed: actionable,
  };
}

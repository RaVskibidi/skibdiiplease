import { z } from 'zod';

const localeSchema = z
  .string()
  .trim()
  .min(2)
  .max(35)
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u, 'must be a valid locale tag');

const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'must be a valid IANA timezone');

/** The editable portion of GuildConfig. */
export const guildConfigValuesSchema = z
  .object({
    locale: localeSchema,
    timezone: timezoneSchema,
    automationMode: z.enum(['OBSERVE', 'ENFORCE_REVERSIBLE', 'ENFORCE_DESTRUCTIVE']),
    antiNukeEnabled: z.boolean(),
    antiRaidEnabled: z.boolean(),
    beastModeEnabled: z.boolean(),
    automodEnabled: z.boolean(),
    verificationEnabled: z.boolean(),
    botProtectionEnabled: z.boolean(),
    loggingEnabled: z.boolean(),
    backupsEnabled: z.boolean(),
    backupIntervalHours: z.number().int().min(1).max(720),
    backupRetentionDays: z.number().int().min(1).max(3650),
  })
  .strict();

export const guildConfigUpdateSchema = guildConfigValuesSchema
  .partial()
  .extend({
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'expectedVersion'),
    'at least one configuration field must be provided',
  );

export type GuildConfigValues = z.infer<typeof guildConfigValuesSchema>;
export type GuildConfigUpdate = z.infer<typeof guildConfigUpdateSchema>;

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake');

/**
 * Explicit owner consent for non-observation automation. The repository verifies
 * `approvedBy` against the guild owner before recording this.
 */
export const enforcementApprovalSchema = z
  .object({
    mode: z.enum(['ENFORCE_REVERSIBLE', 'ENFORCE_DESTRUCTIVE']),
    approvedBy: snowflakeSchema,
    policyVersion: z.string().trim().min(1).max(64),
  })
  .strict();

export type EnforcementApprovalInput = z.infer<typeof enforcementApprovalSchema>;

/**
 * New installations start in observation mode. Destructive automation is never
 * enabled by default and requires an explicit owner approval record.
 */
export const GUILD_CONFIG_DEFAULTS: GuildConfigValues = {
  locale: 'en',
  timezone: 'UTC',
  automationMode: 'OBSERVE',
  antiNukeEnabled: true,
  antiRaidEnabled: true,
  beastModeEnabled: true,
  automodEnabled: false,
  verificationEnabled: false,
  botProtectionEnabled: true,
  loggingEnabled: true,
  backupsEnabled: false,
  backupIntervalHours: 24,
  backupRetentionDays: 30,
};

export function parseGuildConfigUpdate(input: unknown): GuildConfigUpdate {
  return guildConfigUpdateSchema.parse(input);
}

/** Keeps only the keys that actually change, for compact audit diffs. */
export function diffConfigValues(
  before: Partial<GuildConfigValues>,
  after: Partial<GuildConfigValues>,
): Partial<GuildConfigValues> {
  const diff: Partial<GuildConfigValues> = {};

  for (const key of Object.keys(after) as Array<keyof GuildConfigValues>) {
    if (before[key] !== after[key]) {
      // Each branch is the same property; TypeScript cannot narrow the union key.
      (diff as Record<string, unknown>)[key] = after[key];
    }
  }

  return diff;
}

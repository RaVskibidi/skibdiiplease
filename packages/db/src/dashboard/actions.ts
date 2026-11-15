import { z } from 'zod';

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake');

const restoreCategories = [
  'roles',
  'channels',
  'permissions',
  'emojis',
  'stickers',
  'guildSettings',
] as const;

export const restoreSelectionPayloadSchema = z
  .object({
    categories: z.array(z.enum(restoreCategories)).min(1).max(restoreCategories.length),
    roleIds: z.array(snowflakeSchema).max(250).optional(),
    channelIds: z.array(snowflakeSchema).max(500).optional(),
    deleteMissing: z.boolean().optional(),
  })
  .strict();

export const DASHBOARD_ACTION_TYPES = {
  BACKUP_CREATE: 'backup.create',
  BACKUP_DELETE: 'backup.delete',
  BACKUP_PREVIEW: 'backup.preview',
  BACKUP_RESTORE: 'backup.restore',
  BEAST_OVERRIDE: 'beast.override',
} as const;

export type DashboardActionType =
  (typeof DASHBOARD_ACTION_TYPES)[keyof typeof DASHBOARD_ACTION_TYPES];

export const dashboardActionPayloadSchemas = {
  [DASHBOARD_ACTION_TYPES.BACKUP_CREATE]: z
    .object({ retentionDays: z.number().int().min(1).max(3_650).optional() })
    .strict(),
  [DASHBOARD_ACTION_TYPES.BACKUP_DELETE]: z.object({ backupId: z.string().min(1) }).strict(),
  [DASHBOARD_ACTION_TYPES.BACKUP_PREVIEW]: z
    .object({ backupId: z.string().min(1), selection: restoreSelectionPayloadSchema })
    .strict(),
  [DASHBOARD_ACTION_TYPES.BACKUP_RESTORE]: z
    .object({
      backupId: z.string().min(1),
      jobId: z.string().min(1),
      confirmationId: z.string().trim().min(6).max(128),
    })
    .strict(),
  [DASHBOARD_ACTION_TYPES.BEAST_OVERRIDE]: z
    .object({ action: z.enum(['activate', 'calm']), reason: z.string().trim().min(3).max(500) })
    .strict(),
} as const satisfies Record<DashboardActionType, z.ZodType>;

export type DashboardActionPayload<T extends DashboardActionType> = z.infer<
  (typeof dashboardActionPayloadSchemas)[T]
>;

/**
 * Validates a queued action payload before the bot touches Discord. An unknown
 * type is rejected rather than executed with unchecked data.
 */
export function parseDashboardActionPayload(
  type: string,
  payload: unknown,
):
  | { ok: true; type: DashboardActionType; payload: Record<string, unknown> }
  | { ok: false; message: string } {
  const schema = (dashboardActionPayloadSchemas as Record<string, z.ZodType>)[type];
  if (schema === undefined) {
    return { ok: false, message: `Unsupported dashboard action type: ${type}` };
  }
  const result = schema.safeParse(payload ?? {});
  if (!result.success) {
    return {
      ok: false,
      message: result.error.issues.map((issue) => issue.message).join('; '),
    };
  }
  return {
    ok: true,
    type: type as DashboardActionType,
    payload: result.data as Record<string, unknown>,
  };
}

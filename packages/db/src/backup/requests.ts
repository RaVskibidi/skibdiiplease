import { z } from 'zod';

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake');

const PREFIX_PATTERN = /^[a-z0-9][a-z0-9:-]{0,47}$/u;

const requestBase = {
  version: z.literal(1),
  requestId: z.string().trim().min(1).max(64),
  requestedAt: z.string().datetime(),
};

/**
 * Worker -> bot backup control messages.
 *
 * The worker never talks to Discord and never touches snapshot bytes. It only
 * asks the bot, which owns the Discord session and the storage credentials, to
 * capture a scheduled backup or run a retention sweep.
 */
export const backupRequestSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...requestBase,
      type: z.literal('scheduled-backup'),
      guildId: snowflakeSchema,
      retentionDays: z.number().int().min(1).max(3_650),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal('retention-sweep'),
    })
    .strict(),
]);

export type BackupRequest = z.infer<typeof backupRequestSchema>;

export function backupRequestChannel(prefix = 't77'): string {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new Error('T77 backup request channel requires a 1-48 character lowercase prefix.');
  }
  return `${prefix}:backup:requests`;
}

export function encodeBackupRequest(request: BackupRequest): string {
  return JSON.stringify(backupRequestSchema.parse(request));
}

export function decodeBackupRequest(raw: string): BackupRequest | null {
  try {
    const parsed = backupRequestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createRequestId(now: Date = new Date()): string {
  return `backup-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

import type { GuildResource } from '../generated/prisma/client.ts';
import type { Database } from '../client.ts';
import type { DbLogger } from '../logger.ts';
import { silentDbLogger } from '../logger.ts';
import { createTenantContext, type TenantContext } from '../tenant.ts';
import { TenantRepository } from './base.ts';

export type GuildResourceKind = 'CHANNEL' | 'CATEGORY' | 'ROLE' | 'EMOJI' | 'STICKER';

export interface GuildResourceInput {
  type: GuildResourceKind;
  discordId: string;
  name: string;
  position?: number;
  parentId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Dashboard selector snapshots. The API has no bot token, so channel/role names
 * and positions are cached here by the bot and refreshed on sync.
 */
export class GuildResourceRepository extends TenantRepository {
  public constructor(database: Database, tenant: TenantContext, logger: DbLogger = silentDbLogger) {
    super(database, tenant, logger);
  }

  /**
   * Replaces the complete resource set atomically. A partial failure never
   * leaves the dashboard with a half-updated selector list.
   */
  public async replaceAll(resources: readonly GuildResourceInput[]): Promise<number> {
    const deduplicated = deduplicateResources(resources);

    return this.database.transaction(async (transaction) => {
      await transaction.guildResource.deleteMany({ where: { guildId: this.guildId } });

      if (deduplicated.length === 0) {
        return 0;
      }

      await transaction.guildResource.createMany({
        data: deduplicated.map((resource) => ({
          guildId: this.guildId,
          type: resource.type,
          discordId: resource.discordId,
          name: resource.name,
          position: resource.position ?? 0,
          parentId: resource.parentId ?? null,
          metadata: (resource.metadata ?? null) as never,
          syncedAt: new Date(),
        })),
      });

      return deduplicated.length;
    });
  }

  public async list(type?: GuildResourceKind): Promise<GuildResource[]> {
    return this.database.client.guildResource.findMany({
      where: {
        guildId: this.guildId,
        ...(type === undefined ? {} : { type }),
      },
      orderBy: [{ type: 'asc' }, { position: 'asc' }, { name: 'asc' }],
    });
  }
}

/** System entry point used by gateway event handlers after validating the guild. */
export async function syncGuildResources(
  database: Database,
  guildId: string,
  resources: readonly GuildResourceInput[],
  logger: DbLogger = silentDbLogger,
): Promise<number> {
  const tenant = createTenantContext({ guildId });
  return new GuildResourceRepository(database, tenant, logger).replaceAll(resources);
}

function deduplicateResources(resources: readonly GuildResourceInput[]): GuildResourceInput[] {
  const seen = new Set<string>();
  const output: GuildResourceInput[] = [];

  for (const resource of resources) {
    const key = `${resource.type}:${resource.discordId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    if (!/^\d{17,20}$/u.test(resource.discordId)) {
      throw new Error(`Invalid Discord resource ID for ${resource.type}.`);
    }
    if (resource.name.trim().length === 0) {
      throw new Error(`Discord resource ${resource.discordId} requires a name.`);
    }

    output.push(resource);
  }

  return output;
}

import type { GuildConfig } from '../generated/prisma/client.ts';
import type { Database } from '../client.ts';
import type { GuildConfigUpdate } from '../config/schema.ts';
import type { EnforcementApprovalInput } from '../config/schema.ts';
import type { GuildCache } from '../cache/guild-cache.ts';
import type { GuildEventBus } from '../cache/pubsub.ts';
import type { DbLogger } from '../logger.ts';
import { silentDbLogger } from '../logger.ts';
import type { TenantContext } from '../tenant.ts';
import { AccessGrantRepository } from '../repositories/access-repository.ts';
import { AntiRaidRepository } from '../repositories/anti-raid-repository.ts';
import { AuditRepository } from '../repositories/audit-repository.ts';
import { AutomodRepository } from '../repositories/automod-repository.ts';
import { BackupRepository } from '../repositories/backup-repository.ts';
import { BeastModeRepository } from '../repositories/beast-mode-repository.ts';
import { GuildConfigRepository } from '../repositories/config-repository.ts';
import { DashboardActionRepository } from '../repositories/dashboard-action-repository.ts';
import { GuildRepository } from '../repositories/guild-repository.ts';
import { IncidentRepository } from '../repositories/incident-repository.ts';
import { ModerationRepository } from '../repositories/moderation-repository.ts';
import { QuarantineRepository } from '../repositories/quarantine-repository.ts';
import { RestoreRepository } from '../repositories/restore-repository.ts';
import { GuildResourceRepository } from '../repositories/resource-repository.ts';
import { SecurityRepository } from '../repositories/security-repository.ts';
import { VerificationRepository } from '../repositories/verification-repository.ts';
import { WhitelistRepository } from '../repositories/whitelist-repository.ts';

export const GUILD_CONFIG_CACHE_FIELD = 'config';

export interface GuildServicesOptions {
  cache?: GuildCache;
  events?: GuildEventBus;
  logger?: DbLogger;
}

/**
 * Tenant-scoped repository bundle.
 *
 * Every repository created here shares the same immutable TenantContext. Callers
 * cannot replace the guild ID per operation, which makes cross-guild access a
 * type error rather than a runtime convention.
 */
export class GuildServices {
  public readonly database: Database;
  public readonly tenant: TenantContext;
  public readonly log: DbLogger;
  public readonly cache: GuildCache | undefined;
  public readonly events: GuildEventBus | undefined;

  public readonly guild: GuildRepository;
  public readonly config: GuildConfigRepository;
  public readonly audit: AuditRepository;
  public readonly whitelist: WhitelistRepository;
  public readonly access: AccessGrantRepository;
  public readonly moderation: ModerationRepository;
  public readonly incidents: IncidentRepository;
  public readonly security: SecurityRepository;
  public readonly antiRaid: AntiRaidRepository;
  public readonly automod: AutomodRepository;
  public readonly verification: VerificationRepository;
  public readonly beastMode: BeastModeRepository;
  public readonly quarantine: QuarantineRepository;
  public readonly resources: GuildResourceRepository;
  public readonly backups: BackupRepository;
  public readonly restores: RestoreRepository;
  public readonly dashboardActions: DashboardActionRepository;

  public constructor(
    database: Database,
    tenant: TenantContext,
    options: GuildServicesOptions = {},
  ) {
    this.database = database;
    this.tenant = tenant;
    this.log = options.logger ?? silentDbLogger;
    this.cache = options.cache;
    this.events = options.events;

    this.guild = new GuildRepository(database, tenant, this.log);
    this.config = new GuildConfigRepository(database, tenant, this.log);
    this.audit = new AuditRepository(database, tenant, this.log);
    this.whitelist = new WhitelistRepository(database, tenant, this.log);
    this.access = new AccessGrantRepository(database, tenant, this.log);
    this.moderation = new ModerationRepository(database, tenant, this.log);
    this.incidents = new IncidentRepository(database, tenant, this.log);
    this.security = new SecurityRepository(database, tenant, this.log);
    this.antiRaid = new AntiRaidRepository(database, tenant, this.log);
    this.automod = new AutomodRepository(database, tenant, this.log);
    this.verification = new VerificationRepository(database, tenant, this.log);
    this.beastMode = new BeastModeRepository(database, tenant, this.log);
    this.quarantine = new QuarantineRepository(database, tenant, this.log);
    this.resources = new GuildResourceRepository(database, tenant, this.log);
    this.backups = new BackupRepository(database, tenant, this.log);
    this.restores = new RestoreRepository(database, tenant, this.log);
    this.dashboardActions = new DashboardActionRepository(database, tenant, this.log);
  }

  /** Reads configuration through Redis when available, with a DB fallback. */
  public async getConfig(): Promise<GuildConfig> {
    if (!this.cache) {
      return this.config.getOrCreate();
    }

    const cached = await this.cache
      .get<CachedGuildConfig>(this.tenant.guildId, GUILD_CONFIG_CACHE_FIELD)
      .catch((error: unknown) => {
        this.log.warn({ err: error }, 'T77 configuration cache read failed; using PostgreSQL');
        return null;
      });

    if (cached !== null) {
      return reviveConfig(cached);
    }

    const config = await this.config.getOrCreate();
    await this.setConfigCache(config);
    return config;
  }

  /** Writes configuration, invalidates the cache, and notifies other processes. */
  public async updateConfig(
    input: GuildConfigUpdate,
    actorId?: string | null,
  ): Promise<GuildConfig> {
    const config = await this.config.update(input, actorId);
    await this.afterConfigChanged(config);
    return config;
  }

  public async resetConfig(
    actorId?: string | null,
    expectedVersion?: number,
  ): Promise<GuildConfig> {
    const config = await this.config.reset(actorId, expectedVersion);
    await this.afterConfigChanged(config);
    return config;
  }

  /** Owner-only approval for reversible or destructive automation. */
  public async approveEnforcement(input: EnforcementApprovalInput): Promise<GuildConfig> {
    const config = await this.config.approveEnforcement(input);
    await this.afterConfigChanged(config);
    return config;
  }

  /** Returns the guild to observation mode; safe for any authorized operator. */
  public async revokeEnforcement(actorId: string, reason?: string): Promise<GuildConfig> {
    const config = await this.config.revokeEnforcement(actorId, reason);
    await this.afterConfigChanged(config);
    return config;
  }

  /** Replaces dashboard resource snapshots and drops dependent cache entries. */
  public async syncResources(
    resources: Parameters<GuildResourceRepository['replaceAll']>[0],
  ): Promise<number> {
    const count = await this.resources.replaceAll(resources);
    await this.invalidateCache();
    return count;
  }

  /** Drops every cached projection for this guild only. */
  public async invalidateCache(): Promise<void> {
    await this.cache?.invalidateGuild(this.tenant.guildId).catch((error: unknown) => {
      this.log.warn({ err: error }, 'T77 cache invalidation failed; entries expire by TTL');
    });
  }

  private async setConfigCache(config: GuildConfig): Promise<void> {
    try {
      await this.cache?.set(this.tenant.guildId, GUILD_CONFIG_CACHE_FIELD, serializeConfig(config));
    } catch (error) {
      this.log.warn({ err: error }, 'T77 configuration cache write failed');
    }
  }

  private async afterConfigChanged(config: GuildConfig): Promise<void> {
    await this.setConfigCache(config);

    try {
      await this.events?.publish(this.tenant.guildId, 'config.updated', {
        version: config.version,
        automationMode: config.automationMode,
      });
    } catch (error) {
      this.log.warn({ err: error }, 'T77 configuration change notification failed');
    }
  }
}

export function createGuildServices(
  database: Database,
  tenant: TenantContext,
  options: GuildServicesOptions = {},
): GuildServices {
  return new GuildServices(database, tenant, options);
}

type CachedGuildConfig = Omit<GuildConfig, 'enforcementApprovedAt' | 'createdAt' | 'updatedAt'> & {
  enforcementApprovedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function serializeConfig(config: GuildConfig): CachedGuildConfig {
  return {
    ...config,
    enforcementApprovedAt: config.enforcementApprovedAt?.toISOString() ?? null,
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString(),
  };
}

function reviveConfig(config: CachedGuildConfig): GuildConfig {
  return {
    ...config,
    enforcementApprovedAt:
      config.enforcementApprovedAt === null ? null : new Date(config.enforcementApprovedAt),
    createdAt: new Date(config.createdAt),
    updatedAt: new Date(config.updatedAt),
  };
}

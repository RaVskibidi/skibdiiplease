# T77 — Phase 3: Database Architecture and Persistence

**Status:** Implemented and validated. Phase 4 was built on this layer; see [04-phase-4.md](04-phase-4.md).
**Scope:** Prisma schema, migrations, tenant-scoped repositories, cross-guild isolation, configuration persistence, Redis cache and Pub/Sub, append-only audit trail, connection lifecycle, transactions, and tests.

---

## 1. Data model

`packages/db/prisma/schema.prisma` models every T77 module:

| Area | Models |
|---|---|
| Tenant root | `Guild`, `GuildConfig`, `GuildResource` |
| Security configuration | `AntiNukeRule`, `AntiRaidConfig`, `BeastModeState`, `AutomodConfig`, `VerificationConfig`, `LogChannel` |
| Trust and access | `WhitelistEntry`, `AccessGrant`, `BotApproval` |
| Security history | `SecurityIncident`, `SecurityEvent`, `Punishment` |
| Moderation | `ModerationCase`, `Warning` |
| Governance | `AuditEntry`, `CriticalApproval` |
| Verification and backups | `VerificationChallenge`, `Backup`, `RestoreJob` |
| Dashboard identity | `OAuthIdentity`, `OAuthCredential`, `DashboardSession` |

Every tenant-owned row carries `guildId` with a foreign key to `Guild`. Child rows cascade on tenant deletion except `AuditEntry`, which uses `Restrict` so history cannot disappear accidentally.

New guilds start with `automationMode = OBSERVE`. Destructive enforcement is never enabled by default.

Dashboard OAuth credentials are stored only as AES-GCM ciphertext plus IV/auth tag columns (`accessTokenCiphertext`, `refreshTokenCiphertext`, `iv`, `authTag`). No Discord access or refresh token is stored in plaintext.

## 2. Migrations

Prisma 7 uses the `prisma-client` generator, the `@prisma/adapter-pg` driver adapter, and `prisma.config.ts`.

```bash
# Generate the client (also runs before typecheck/test)
pnpm db:generate

# Apply migrations to the configured DATABASE_URL
pnpm db:migrate

# Inspect pending migrations
pnpm db:status
```

Migration history:

1. `20261114152901_init` — complete schema, constraints, indexes, and foreign keys.
2. `20261114153000_audit_append_only` — PostgreSQL functions and triggers that reject `UPDATE`, `DELETE`, and `TRUNCATE` on `audit_entries`.

The integration suite drops and recreates the `public` schema, then runs `prisma migrate deploy` against the empty database. This proves the migration chain works from a clean database.

## 3. Tenant isolation

`src/tenant.ts` defines an immutable `TenantContext` created only from a validated Discord guild snowflake. `TenantRepository` (in `src/repositories/base.ts`) requires that context and:

- Builds every query with `guildId` from the context, never from an operation argument.
- Rejects a forged or malformed context at construction.
- Verifies fetched rows with `assertRowOwnership` / `assertGuildRowOwnership`.
- Uses `updateMany` with both the row ID and `guildId`, so a cross-guild identifier cannot mutate another tenant even if a row lookup is bypassed.

`GuildServices` composes every repository for one tenant. The guild ID cannot be changed per operation.

Integration tests create two guilds and prove isolation across configuration, whitelist, access grants, moderation cases, incidents, resources, backups, and audit reads. Cross-guild revoke/close/mark-ready calls fail with typed `TenantRecordNotFoundError`; reads return `null` or an empty collection.

### Optional row-level security

PostgreSQL RLS is intentionally not enabled yet. The repository guard is the enforcement boundary; RLS would require a per-request `SET LOCAL` session variable through Prisma and a dedicated app role. This is documented as a future defense-in-depth option, not a completed feature.

## 4. Configuration persistence

`GuildConfigRepository`:

- Validates updates with Zod.
- Reads and writes only the caller's guild.
- Increments `version` on every write.
- Supports optimistic concurrency with `expectedVersion`; stale writes raise `ConfigVersionConflictError`.
- Writes `before`, `after`, and a compact `diff` to the audit trail in the same transaction.
- Provides `reset` to restore observation-safe defaults.

`GuildServices.getConfig` is read-through: it checks Redis first, then loads from PostgreSQL and populates the cache. `updateConfig` and `resetConfig` refresh the cache and publish a `config.updated` Pub/Sub event.

## 5. Transactions and sequence integrity

- `Database.transaction` applies bounded `timeout` and `maxWait` defaults.
- Moderation case numbers are allocated under `SELECT ... FOR UPDATE` on the guild row, then incremented and inserted in the same transaction. Concurrent tests prove gap-free numbering (`1..8`) without duplicates.
- Bootstrapping a guild creates the guild row, configuration rows, and the bootstrap audit entry atomically.
- If a transaction throws, every write rolls back. The integration suite proves this with a forced failure.
- Duplicate `GuildCreate` delivery is idempotent; bootstrap refreshes metadata without resetting configuration.

## 6. Audit trail

`AuditRepository` exposes `append`, `list`, and `count` only. There is no update or delete method. PostgreSQL triggers independently reject:

- `UPDATE` on any audit row.
- `DELETE` on any audit row.
- `TRUNCATE` on the table.

Audit entries include actor type/ID, action, target, before/after/diff JSON, request ID, IP hash, user agent, and confirmation ID. Raw message content is never required by the schema.

## 7. Redis cache and Pub/Sub

`RedisConnection` owns:

- One lazy command connection.
- One lazy subscriber connection (separate because subscribed connections cannot issue normal commands).
- Bounded reconnect attempts, connect timeout, `PING` health checks, and graceful close.

`GuildCache`:

- Builds every key as `<prefix>:guild:<guildId>:cache:<field>`.
- Validates the prefix, guild snowflake, and field to prevent glob injection.
- Wraps values in a versioned envelope containing guild ID, field, and timestamp.
- Treats a misplaced, cross-guild, or corrupt value as a cache miss.
- Invalidates a single guild with a bounded `SCAN` + `UNLINK`.

`GuildEventBus` publishes versioned envelopes on `<prefix>:guild:<guildId>:events`. Subscribers re-check the envelope guild ID and ignore malformed or cross-guild messages.

## 8. Bot integration

`apps/bot/src/bootstrap/infrastructure.ts` constructs the database, Redis connection, cache, and event bus without opening connections. `application.start()` connects PostgreSQL and Redis before Discord login; `application.stop()` closes the Discord client, health server, Redis, and the database pool.

Gateway integration:

- `GuildCreate` bootstraps the guild and refreshes its channel/role/emoji/sticker projection.
- `GuildDelete` marks `botLeftAt` and appends an audit entry without deleting history.
- `ClientReady` reconciles every guild the bot is currently in, repairing rows created while T77 was offline.

`/readyz` now checks PostgreSQL and Redis in addition to gateway and command-registration state. Missing dependencies return `503`.

New environment variables: `DATABASE_URL`, `REDIS_URL`, `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`, `DB_SLOW_QUERY_MS`, `REDIS_KEY_PREFIX`, `CACHE_TTL_SECONDS`.

## 9. Tests

Unit tests (`packages/db/test/unit`):

- Tenant context validation, guard behavior, and snowflake checks.
- Configuration defaults, update validation, and diff generation.
- Cache key namespacing, envelope validation, cache-miss behavior, and per-guild invalidation.
- Pub/Sub envelope encoding, guild-scoped delivery, and cross-guild rejection.

Integration tests (`packages/db/test/integration`):

- Clean-database migration chain, all tenant tables, ciphertext-only OAuth columns.
- PostgreSQL append-only triggers.
- Cross-guild isolation across every repository.
- Bootstrap idempotency.
- Configuration versioning, conflict rejection, reset, and audit diffs.
- Forced transaction rollback.
- Concurrent moderation case sequencing and cursor pagination.
- Deduplicated security events.
- Real Redis read-through caching and cross-connection Pub/Sub.

Run them:

```bash
pnpm test

TEST_DATABASE_URL='postgresql://t77@127.0.0.1:55432/t77_test?schema=public' \
TEST_REDIS_URL='redis://127.0.0.1:56379/15' \
pnpm --filter @t77/db test:integration
```

The integration runner drops the test schema and flushes the selected Redis database. Never point it at production.

## 10. Acceptance criteria

| Criterion | Result |
|---|---|
| Complete Prisma schema for all modules | Complete |
| PostgreSQL migrations from a clean database | Proven by integration setup |
| Guild-scoped tenant repositories | Complete |
| Strict cross-guild isolation with tests | Complete |
| Guild configuration persistence | Complete with optimistic versioning |
| Redis caching and Pub/Sub | Complete |
| Append-only audit trail | Application and PostgreSQL enforced |
| Connection lifecycle and graceful shutdown | Complete |
| Transaction handling | Bounded defaults; rollback and sequence tests pass |
| Unit and integration tests | 23 unit + 29 integration tests pass |
| No plaintext Discord tokens | Ciphertext-only OAuth columns |
| Documentation updated | README and this document |

## 11. Honest limitations

- Docker Compose and the production image were not executed in this environment because Docker is unavailable. The Dockerfile was updated for `@t77/db` and Prisma generation but remains syntax-level validation only.
- A live Discord gateway run still requires a real bot token and a private test guild. Startup wiring, guild reconciliation, and ready-state dependency checks are covered by unit tests and type checking, not by a live connection.
- PostgreSQL RLS is deferred. Application-level tenant guards are tested; database-enforced per-session RLS is not enabled.
- The dashboard API and worker do not exist yet, so Redis Pub/Sub has no non-bot consumers in this phase.
- Backups, punishments, verification challenges, critical approvals, and dashboard sessions have schema and partial repositories, but their engines/UI arrive in later phases. No placeholder command or dead button was added.

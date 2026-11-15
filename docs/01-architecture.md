# T77 — Phase 1 Architecture

**Status:** Proposed architecture, pending approval.
**Scope of this phase:** reference analysis, architecture, safety model, data design, project structure, testing/deployment strategy, limitations, and phase plan. No implementation code has been written yet.

---

## 1. Reference Analysis

The following public references were reviewed:

- https://securitybot.gg/
- https://docs.securitybot.gg/
- https://docs.securitybot.gg/anti-nuke/anti-nuke.md
- https://docs.securitybot.gg/anti-nuke/anti-nuke/check-settings.md
- https://docs.securitybot.gg/anti-nuke/anti-nuke/changing-limits.md
- https://docs.securitybot.gg/anti-nuke/anti-nuke/changing-punishments.md
- https://docs.securitybot.gg/anti-nuke/anti-nuke/enable-disable-action-triggers.md
- https://docs.securitybot.gg/anti-nuke/anti-nuke/dangerous-permissions.md
- https://docs.securitybot.gg/other-modules/anti-raid.md
- https://docs.securitybot.gg/other-modules/beast-mode.md
- https://docs.securitybot.gg/other-modules/verification.md
- https://docs.securitybot.gg/other-modules/moderation.md
- https://docs.securitybot.gg/other-modules/logs.md
- https://docs.securitybot.gg/getting-started/manage-settings.md
- https://docs.securitybot.gg/whitelist/whitelist.md
- https://docs.securitybot.gg/whitelist/whitelist/user-whitelist.md
- https://docs.securitybot.gg/whitelist/whitelist/role-whitelist.md
- https://docs.securitybot.gg/whitelist/whitelist/channel-whitelist.md
- https://docs.securitybot.gg/premium/premium-features.md

### Feature coverage observed

| Area | Reference model | T77 design decision |
|---|---|---|
| Anti-Nuke | Fixed 10-minute reset; per-action limits; triggers; punishments; whitelists | Configurable windows, durable audit trail, observation mode by default, reversible containment preferred, explicit owner approval before destructive automation |
| Anti-Raid | Score from account age, join speed, avatar; aggregate threshold; lock and punish | Layered risk scoring, quarantine + verification by default, minimum confidence gate, no auto-ban from a single weak signal |
| Beast Mode | Global score; punitive mode that can punish anyone doing a dangerous action | Heightened server-wide scrutiny and containment, but **each action is authorized independently**; owner-only emergency override |
| Verification | Unverified role, CAPTCHA or button, manual verification | Same core workflow with one-time challenges, retry limits, audit logs, accessibility fallback |
| Moderation | Custom T77 permissions, cases, anti-nuke limits | Granular staff grants, case IDs, hierarchy enforcement, reversible actions, confirmations, full audit |
| Whitelist | User/role/channel, global and per-action | Expiring entries, reasons, immutable history, explicit precedence, owner-controlled critical trust changes |
| Settings | Dashboard and commands stay in sync | PostgreSQL as source of truth; Redis cache invalidation; versioned configuration and append-only audit entries |
| Logs | Protection and moderation events | Dedicated log categories and incident/case references; dashboard audit viewer |

### Intentional differences from the reference product

1. **No blanket Beast Mode punishment.** Activating Beast Mode does not make every moderator an offender. It raises scrutiny and may apply containment only after evaluating the actor's authorization, hierarchy, whitelist status, and the specific action.
2. **Observation first.** New installations do not perform destructive automation. The owner must explicitly approve enforcement after setup and verification.
3. **Durable event pipeline.** Counters live in Redis for speed, but every security event and incident is persisted in PostgreSQL for audit and recovery.
4. **More transparent trust controls.** Whitelist changes, enforcement approvals, and security-admin grants have explicit confirmation and history.
5. **Original branding and copy.** T77 uses its own shield identity, design tokens, embeds, command copy, and dashboard.

---

## 2. Product and Safety Principles

1. **Protect, do not escalate unnecessarily.** The default response to uncertainty is alert + observe, not ban.
2. **Discord permissions are the ceiling.** T77 never attempts to bypass role hierarchy, owner immunity, or API restrictions.
3. **Destructive automation requires informed owner consent.** Observation is the default. Enabling reversible enforcement and destructive enforcement are separate decisions.
4. **Every action is attributable.** Security events, moderation cases, incidents, config changes, and restores have actor IDs, timestamps, reasons, and correlation IDs.
5. **Tenant isolation is mandatory.** Every guild-scoped query and mutation carries a `guildId`; cross-guild access is tested.
6. **No fake functionality.** A feature is documented and exposed only when its backend path works. Unsupported Discord capabilities are stated plainly.
7. **Minimise sensitive data.** Message content is not stored by default. Only short, redacted snippets or hashes are retained for anti-spam evidence.
8. **Safe degradation.** If an intent, permission, or channel is missing, the affected module reports "degraded" instead of pretending to protect.

---

## 3. Runtime Architecture

```text
                            ┌──────────────────────────────┐
                            │        Discord Gateway       │
                            │  guilds, members, moderation │
                            │  messages, audit log events  │
                            └──────────────┬───────────────┘
                                           │
                  ┌────────────────────────▼────────────────────────┐
                  │ apps/bot                                        │
                  │ gateway client · command router · interactions  │
                  │ event normalizer · security orchestrator        │
                  │ permission checks · action dispatcher           │
                  └───────┬───────────────────────┬─────────────────┘
                          │                       │
          ┌───────────────▼──────────┐   ┌────────▼─────────────────┐
          │ packages/security-core   │   │ Redis                    │
          │ pure, deterministic      │   │ counters · rate limits   │
          │ anti-nuke/raid/beast/    │   │ sessions · queues        │
          │ automod scoring          │   │ pub/sub · CAPTCHA state  │
          └───────────────┬──────────┘   └────────┬─────────────────┘
                          │                       │
                  ┌───────▼───────────────────────▼──────────────┐
                  │ PostgreSQL + Prisma                           │
                  │ config · incidents · events · cases · audit    │
                  │ backups metadata · access grants               │
                  └───────▲───────────────────────▲──────────────┘
                          │                       │
          ┌───────────────┴─────────┐   ┌─────────┴────────────────┐
          │ apps/api                │   │ apps/worker              │
          │ Express · OAuth2 · REST │   │ BullMQ jobs: backups,    │
          │ SSE · validation        │   │ restores, retention,     │
          │ NEVER holds bot token   │   │ scheduled moderation     │
          └───────────────▲─────────┘   └─────────▲────────────────┘
                          │                       │
                  ┌───────┴───────────────────────┴──────────────┐
                  │ apps/web — React SPA                         │
                  │ dashboard, dark T77 design system            │
                  └──────────────────────────────────────────────┘
```

### Component responsibilities

| Component | Responsibilities | Must never |
|---|---|---|
| `apps/bot` | Gateway connection, slash commands, buttons/modals/selects, event normalization, security decisions, immediate Discord actions, Discord log delivery | Expose the bot token or accept unauthenticated dashboard commands |
| `apps/api` | Discord OAuth2, sessions, guild-scoped REST API, validation, permission middleware, SSE status stream, config writes | Send the bot token to the browser or trust client-side authorization |
| `apps/web` | Dashboard UI, server picker, forms, confirmations, live status | Store Discord tokens in `localStorage` or call Discord APIs with secrets |
| `apps/worker` | Long-running jobs: backup capture, restore execution, retention, scheduled unbans, verification cleanup, log retries | Run destructive jobs without a confirmation record and idempotency key |
| `packages/security-core` | Pure risk scoring and threshold decisions with injected clock/randomness | Import Discord.js, Prisma, or network clients |
| `packages/db` | Prisma schema, migrations, tenant-scoped repositories, seed data | Allow raw cross-guild queries from outside the repository layer |
| `packages/shared` | Shared TypeScript types, Zod schemas, enums, permission constants, branding tokens | Contain secrets or runtime-specific logic |

### Bot token exposure boundary

- `DISCORD_TOKEN` is available only to `bot` and `worker` (worker uses Discord REST for backups/restores).
- `api` receives only `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and the OAuth redirect URI.
- `web` receives no Discord secrets.
- Dashboard-triggered Discord actions are written to PostgreSQL and published through Redis; the bot or worker executes them.

---

## 4. Technology Baseline

Versions will be pinned during scaffolding after compatibility checks.

| Layer | Choice |
|---|---|
| Runtime | Node.js 24 LTS |
| Language | TypeScript 5.9.3 (strict), pinned for compatibility with the current typescript-eslint release |
| Discord | discord.js v14 (latest stable 14.x) |
| Database | PostgreSQL 16+ |
| ORM | Prisma 7.x |
| Cache / queues | Redis 7+ via ioredis and BullMQ |
| API | Express 5.x |
| Frontend | React 19 + Vite + TypeScript |
| UI | Tailwind CSS + accessible custom T77 components (Radix primitives where useful) |
| Validation | Zod |
| Testing | Vitest, Supertest, Testcontainers, Playwright |
| Package manager | pnpm workspaces |
| Deployment | Docker and Docker Compose reference deployment |

**Required Discord configuration**

- Privileged intents: `Guild Members`, `Message Content`.
- Standard intents: `Guilds`, `Guild Moderation`, `Guild Messages` (and any event-specific intents needed by discord.js).
- `Guild Members` is needed for joins, leaves, verification, and role hierarchy checks.
- `Message Content` is needed for banned words, links, invites, caps, and duplicate detection. If unavailable, content-based automod is reported as degraded and disabled; it is not silently faked.
- Public bot scale beyond 100 guilds requires Discord verification and sharding planning.

---

## 5. Monorepo Structure

```text
t77/
├── apps/
│   ├── bot/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── bootstrap/
│   │   │   │   ├── client.ts
│   │   │   │   ├── container.ts
│   │   │   │   ├── env.ts
│   │   │   │   └── shutdown.ts
│   │   │   ├── discord/
│   │   │   │   ├── events/
│   │   │   │   │   ├── guild-audit-log-entry-create.ts
│   │   │   │   │   ├── guild-create.ts
│   │   │   │   │   ├── guild-member-add.ts
│   │   │   │   │   ├── guild-member-remove.ts
│   │   │   │   │   ├── interaction-create.ts
│   │   │   │   │   ├── message-create.ts
│   │   │   │   │   ├── message-delete.ts
│   │   │   │   │   └── ready.ts
│   │   │   │   ├── commands/
│   │   │   │   │   ├── t77/
│   │   │   │   │   ├── moderation/
│   │   │   │   │   └── registry.ts
│   │   │   │   ├── interactions/
│   │   │   │   │   ├── buttons/
│   │   │   │   │   ├── modals/
│   │   │   │   │   └── selects/
│   │   │   │   └── ui/
│   │   │   │       ├── embeds.ts
│   │   │   │       ├── components.ts
│   │   │   │       └── errors.ts
│   │   │   ├── security/
│   │   │   │   ├── orchestrator.ts
│   │   │   │   ├── audit-resolver.ts
│   │   │   │   ├── action-dispatcher.ts
│   │   │   │   ├── anti-nuke/
│   │   │   │   ├── anti-raid/
│   │   │   │   ├── beast-mode/
│   │   │   │   ├── bot-protection/
│   │   │   │   └── automod/
│   │   │   ├── modules/
│   │   │   │   ├── verification/
│   │   │   │   ├── moderation/
│   │   │   │   ├── whitelist/
│   │   │   │   ├── logging/
│   │   │   │   └── backups/
│   │   │   ├── permissions/
│   │   │   │   ├── discord-permissions.ts
│   │   │   │   └── t77-permissions.ts
│   │   │   ├── queues/
│   │   │   └── scheduler/
│   │   └── test/
│   ├── api/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── app.ts
│   │   │   ├── auth/
│   │   │   │   ├── oauth.ts
│   │   │   │   ├── session.ts
│   │   │   │   └── csrf.ts
│   │   │   ├── middleware/
│   │   │   │   ├── require-session.ts
│   │   │   │   ├── require-guild-access.ts
│   │   │   │   ├── require-permission.ts
│   │   │   │   ├── rate-limit.ts
│   │   │   │   └── error-handler.ts
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts
│   │   │   │   ├── guilds.ts
│   │   │   │   ├── security.ts
│   │   │   │   ├── anti-nuke.ts
│   │   │   │   ├── anti-raid.ts
│   │   │   │   ├── beast-mode.ts
│   │   │   │   ├── automod.ts
│   │   │   │   ├── verification.ts
│   │   │   │   ├── whitelist.ts
│   │   │   │   ├── moderation.ts
│   │   │   │   ├── bot-protection.ts
│   │   │   │   ├── backups.ts
│   │   │   │   ├── audit.ts
│   │   │   │   ├── staff.ts
│   │   │   │   └── settings.ts
│   │   │   ├── services/
│   │   │   ├── realtime/
│   │   │   └── validation/
│   │   └── test/
│   ├── web/
│   │   ├── src/
│   │   │   ├── main.tsx
│   │   │   ├── app/
│   │   │   ├── routes/
│   │   │   ├── components/
│   │   │   │   ├── layout/
│   │   │   │   ├── forms/
│   │   │   │   ├── feedback/
│   │   │   │   └── t77/
│   │   │   ├── features/
│   │   │   │   ├── overview/
│   │   │   │   ├── security-status/
│   │   │   │   ├── anti-nuke/
│   │   │   │   ├── anti-raid/
│   │   │   │   ├── beast-mode/
│   │   │   │   ├── anti-spam/
│   │   │   │   ├── automod/
│   │   │   │   ├── verification/
│   │   │   │   ├── whitelist/
│   │   │   │   ├── moderation/
│   │   │   │   ├── bot-protection/
│   │   │   │   ├── backup-recovery/
│   │   │   │   ├── audit-logs/
│   │   │   │   ├── staff-permissions/
│   │   │   │   └── settings/
│   │   │   ├── lib/
│   │   │   └── styles/
│   │   └── e2e/
│   └── worker/
│       ├── src/
│       │   ├── index.ts
│       │   ├── jobs/
│       │   └── processors/
│       └── test/
├── packages/
│   ├── db/
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   └── migrations/
│   │   ├── src/
│   │   │   ├── client.ts
│   │   │   ├── tenant.ts
│   │   │   ├── repositories/
│   │   │   └── seed.ts
│   │   └── test/
│   ├── security-core/
│   │   ├── src/
│   │   │   ├── anti-nuke/
│   │   │   ├── anti-raid/
│   │   │   ├── beast-mode/
│   │   │   ├── automod/
│   │   │   └── shared/
│   │   └── test/
│   └── shared/
│       ├── src/
│       │   ├── types/
│       │   ├── schemas/
│       │   ├── constants/
│       │   ├── permissions/
│       │   ├── branding/
│       │   ├── errors/
│       │   └── logger/
│       └── test/
├── infra/
│   ├── docker/
│   ├── nginx/
│   └── monitoring/
├── docs/
│   ├── 01-architecture.md
│   ├── 02-security-model.md
│   ├── 03-command-reference.md
│   ├── 04-deployment.md
│   └── 05-limitations.md
├── scripts/
├── tests/
├── .env.example
├── .gitignore
├── compose.yaml
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── README.md
```

---

## 6. Data Architecture

### Core tenancy and configuration

| Model | Purpose | Key points |
|---|---|---|
| `Guild` | Installed server | Discord guild ID, owner ID, case sequence, joined time, bot state |
| `GuildConfig` | General settings | Locale, timezone, automation mode, feature flags, config version |
| `GuildResource` | Dashboard selectors and snapshots | Cached channels/roles with IDs, names, positions; synced by bot; used because the API has no bot token |
| `AntiNukeRule` | Per-action security policy | Action type, enabled, threshold, window, containment, destructive approval |
| `AntiRaidConfig` | Join risk configuration | Scores, threshold, reset, quarantine role, lock policy, bypasses |
| `BeastModeState` | Current global protection state | Enabled, active, score, activated/expires, incident ID, manual override |
| `AutomodConfig` | Spam/content policy | Thresholds, word/domain lists, exemptions, actions |
| `VerificationConfig` | Verification workflow | Mode, roles, channel, challenge difficulty, timeout, attempts |
| `LogChannel` | Log routing | Category-to-channel mapping, enabled flag |

### Trust, access, and history

| Model | Purpose | Key points |
|---|---|---|
| `WhitelistEntry` | Anti-Nuke exemptions | Target type, target ID, scope, reason, creator, expiry, revocation |
| `AccessGrant` | T77 staff permissions | User/role subject, permission keys, grantor, expiry, revocation |
| `BotApproval` | Allowed bots | Approved bot ID, approver, reason, expiry |
| `ModerationCase` | Moderation record | Per-guild case number, type, target, moderator, reason, duration, status |
| `Warning` | Warn history | Linked case, guild, target, moderator, reason, active flag |
| `SecurityIncident` | Correlated security event | Type, severity, status, score, actor summary, opened/closed, override metadata |
| `SecurityEvent` | Normalized event ledger | Action type, actor, target, source, audit log ID, risk score, incident ID |
| `Punishment` | Applied or proposed containment | Incident, actor, type, status, idempotency key, reversal info |
| `AuditEntry` | Dashboard/config audit | Actor, action, before/after diff, IP hash, user agent, confirmation ID |
| `CriticalApproval` | Owner consent record | Guild, owner, action, digest, expiry, consumed timestamp |

### Backup and verification

| Model | Purpose | Key points |
|---|---|---|
| `Backup` | Snapshot metadata | Type, status, schema version, checksum, object key, size, retention, creator |
| `RestoreJob` | Restore lifecycle | Backup, selection, preview, status, progress, errors, confirmation ID |
| `VerificationChallenge` | Challenge state | User, mode, answer hash, expiry, attempts, status; never plaintext answer |
| `OAuthIdentity` | Minimal OAuth identity | Discord user ID, display metadata; no Discord token stored here |

### Data rules

- Every tenant table has `guildId` and composite indexes beginning with `guildId`.
- Foreign keys use `onDelete: Cascade` only where guild deletion semantics are safe; audit and incident history use explicit retention jobs.
- `SecurityEvent` has a unique dedupe key, e.g. `(guildId, source, externalEventId)`. Audit log entry IDs are used where available; gateway message events use message IDs.
- `ModerationCase.number` is allocated in a transaction with a row lock on the guild case counter.
- Prisma migrations are committed. Production uses `prisma migrate deploy`; seeding is explicit, never automatic in production.
- Timestamps are UTC. Dashboard display uses the guild timezone setting.
- No raw message bodies are stored for normal security logs. Anti-spam evidence is redacted and short-lived.

### Tenant isolation

1. All data access goes through `packages/db` repositories that require a `TenantContext` containing `guildId`.
2. API route middleware resolves the guild from the path after verifying session access; services receive the resolved context, not raw path input.
3. Bot event handlers derive the guild from the Discord object, never from user-supplied input.
4. Cross-guild ID probing is covered by integration tests.
5. Optional PostgreSQL row-level security can be added as defense in depth without changing the service contract.

---

## 7. Core Security Event Pipeline

```text
Discord event / interaction
        │
        ▼
1. Normalize and validate
   - guild ID, actor ID, target ID, action type, timestamp
   - audit log entry ID or message ID
        │
        ▼
2. Deduplicate
   - unique external event ID in PostgreSQL
   - short-lived Redis guard for burst duplicates
        │
        ▼
3. Resolve actor and authorization
   - audit log executor, if available
   - owner / role hierarchy / T77 grant / whitelist
   - module exemptions and bot self-actions
        │
        ▼
4. Evaluate pure engine
   - threshold/window/risk score
   - observation vs enforcement mode
   - incident aggregation and Beast Mode scrutiny
        │
        ▼
5. Decide
   - allow, alert, contain, or escalate
   - destructive action only if owner-approved and permitted
        │
        ▼
6. Act
   - idempotent action dispatcher
   - audit reason on every Discord action
   - retry/backoff; never bypass hierarchy
        │
        ▼
7. Persist and notify
   - SecurityEvent, Incident, Punishment, log delivery
   - dashboard SSE event
```

The pure engine returns a decision object; it never performs I/O. The bot adapter resolves Discord data, persists decisions, and dispatches actions. This makes threshold and false-positive behavior deterministic and unit testable.

### Reliability rules

- Redis is the fast path for counters, but PostgreSQL is the durable event ledger.
- If Redis is unavailable, security monitoring enters a degraded state and alerts the owner; it does not silently stop counting.
- Security actions use idempotency keys so retries cannot ban or kick twice.
- Action dispatch respects Discord 429 responses, global concurrency limits, and role hierarchy.
- Log delivery failure is retried and surfaced in dashboard health; it never blocks the security decision.

---

## 8. Module Designs

### 8.1 Anti-Nuke and dangerous-action monitoring

**Action catalog** (all configurable, individually enabled/disabled):

- Member ban, kick, prune.
- Channel create, delete, rename, permission-overwrite changes.
- Role create, delete, rename, permission changes.
- Administrator or dangerous-permission grants.
- Bot addition.
- Webhook creation and abuse signals.
- Mass role assignment.
- Server setting changes, vanity URL changes, server name/icon changes.
- Invite deletion abuse.
- Emoji and sticker deletion or rename.
- Integration changes where Discord exposes them.
- Dangerous role assignment.

**Detection**

- Primary source: `GuildAuditLogEntryCreate` and related gateway events.
- Resolve executor from the audit log entry, target, and change diff.
- Deduplicate by audit log entry ID.
- Count per actor and action in a sliding Redis sorted set with the configured window (default 600 seconds; configurable per rule).
- Persist every normalized event and threshold crossing.
- Treat missing/modified audit log attribution as "unknown actor"; alert rather than guess and punish.

**Authorization checks, in order**

1. T77 internal action (never counts as an external actor's action).
2. Server owner.
3. Actor role higher than or equal to T77's highest role: no bot-enforced punishment; alert owner that manual review/hierarchy correction is required.
4. Global user whitelist.
5. Per-action user whitelist.
6. Global role whitelist.
7. Per-action role whitelist.
8. Module/action exemption.
9. Otherwise evaluate threshold.

Whitelists exempt only from Anti-Nuke policy. They do not grant moderation rights, bypass Discord permissions, or hide actions from audit logs.

**Modes**

| Mode | Behaviour |
|---|---|
| `OBSERVE` (default) | Count, score, alert, create incident; no Discord punishment |
| `ENFORCE_REVERSIBLE` | Allow approved reversible containment (quarantine, role removal, timeout) |
| `ENFORCE_DESTRUCTIVE` | Allow approved destructive actions (kick/ban) for explicitly approved rules |

Enabling `ENFORCE_REVERSIBLE` or `ENFORCE_DESTRUCTIVE` requires an owner-confirmed approval record containing the policy version, scope, timestamp, and a digest of the confirmation. Destructive enforcement is never enabled by default and cannot be enabled from a non-owner staff grant.

**Punishment policy**

- Punishments: none/alert, quarantine, remove roles, timeout, kick, ban.
- Default containment preference: quarantine or role removal.
- Bans/kicks require an explicit destructive-enforcement approval.
- If the bot cannot act due to hierarchy or missing permissions, it records a failed containment and alerts the owner.
- Automatic punishment is a best-effort safety response, not a guarantee. A compromised administrator above T77's role can still cause damage.

**False-positive safeguards**

- Observe mode by default.
- Known and self actions excluded.
- Per-action windows; no single global counter.
- Audit-log deduplication and event-ID idempotency.
- Confirmation before broad policy changes.
- Cooldown after an incident to avoid punishment cascades.
- Incident review and manual release controls.
- Optional "two-signal" escalation for destructive rules; owner can require multiple independent signals.
- Clear "would have acted" records in observe mode.

**Safe recovery**

- Incident creation captures the current policy, actor, event, and relevant snapshot reference.
- Reversible changes (permission overwrite, role grant) can be reverted with preview/confirmation where Discord API supports it.
- Deleted channels/roles are restored from the latest backup only after a preview and explicit approval. IDs will change.
- T77 never claims that a punishment or restore guarantees full recovery.

### 8.2 Bot and permission protection

- Detect new bot additions; require approval or quarantine until reviewed, if enabled.
- Detect Administrator grants and dangerous permission additions to roles.
- Detect dangerous role assignments to members.
- Detect integration create/update/delete where audit logs expose them.
- Alert, optionally revert a role permission change or remove a role, and record the previous state.
- All remediation is hierarchy-aware and confirmation-gated for destructive or broad changes.
- `BotApproval` stores explicitly trusted bot IDs; unapproved bots trigger alerts.

### 8.3 Anti-Raid

**Scoring inputs** (all configurable, with a minimum confidence threshold):

- Account age relative to a configured minimum.
- Time since the previous join ("join row").
- Missing or default avatar.
- Optional public Discord badge bypass.
- Invite code used, when available.
- Existing verification state and whitelist status.
- Recent join velocity and aggregate score.

**Decision policy**

- Track joins in a sliding window (default 60 seconds, configurable).
- Aggregate risk score; trigger only when the threshold is crossed and the minimum number of independent signals is met.
- Default response: assign quarantine role, require verification, alert owner, and optionally lock channels.
- Auto-ban is **not** the default and cannot occur from one weak signal. It requires explicit owner-approved policy and role hierarchy.
- Temporary invite lockdown: delete visible invites and raise the server verification level where API-supported. Discord has no true "pause all invites" API; vanity links and external existing invites may remain. This limitation is surfaced in the UI.
- Incidents hold flagged join IDs so staff can release or verify members manually.
- Score windows reset on a schedule and decay after the incident ends.

### 8.4 Beast Mode

**Purpose:** server-wide emergency scrutiny, not blanket collective punishment.

**Activation**

- A configurable global risk score aggregates risky actions over a window.
- When the threshold is exceeded, T77 opens a Beast incident, alerts the owner and security log, and enters heightened monitoring for a configured duration (default 60 minutes, configurable).
- Activation can optionally apply restrictive server measures (channel lockdown, verification level increase, invite cleanup) only if pre-approved.

**During activation**

- Each dangerous action is still evaluated independently:
  - Is the actor the owner or above T77's role?
  - Is the actor whitelisted for this action?
  - Does the actor have an explicit T77 moderation grant for this action?
  - Is this a legitimate T77 moderation command with a case?
- Authorized staff actions are logged and allowed; they are not punished merely because Beast Mode is active.
- Unauthorized dangerous actions may receive approved containment immediately.
- The dashboard and `/t77 beast status` show score, activation time, expiry, incident, and recent contributing events.

**Deactivation**

- Automatic after the configured duration with no new qualifying incidents.
- Owner-only manual override (`/t77 beast calm` and dashboard) with a recorded reason.
- Manual activation/deactivation is owner-only for the emergency override; security admins may adjust non-emergency settings if authorized.
- Full incident timeline and contributing events remain in history.

### 8.5 Anti-Spam and AutoMod

**Detections**

- Message flood per user/channel.
- Duplicate/near-duplicate messages using normalized hashes.
- Mention spam, including `@everyone`/`@here` abuse.
- Excessive caps with a minimum-length gate.
- Repeated links and invite links.
- Banned words (literal, normalized; no unsafe arbitrary regex).
- Blocked domains (parsed host with suffix matching, no URL fetching).
- Optional ghost-ping detection from a short-lived mention cache.
- Per-channel and per-role exemptions.

**Actions**

- Delete message, warn, timeout, alert, or escalate to moderation case.
- Timeout durations are bounded and validated.
- Policies are per guild and versioned.
- Message content is processed in memory; only redacted evidence is stored.
- If `Message Content` intent is unavailable, the module is disabled and clearly reported.

Discord's native AutoMod can be used alongside T77, but T77 does not depend on it for its own documented detections.

### 8.6 Verification

**Workflow**

1. New member joins; T77 assigns the configured unverified role if possible.
2. The member sees the verification channel only.
3. The member chooses button verification or image CAPTCHA (if enabled).
4. CAPTCHA challenge is generated server-side as a short-lived image; only a hash is stored.
5. On success, T77 removes the unverified role and adds the verified role.
6. A verification log entry is emitted with attempt and outcome.

**Controls**

- Configurable difficulty and challenge length.
- Expiry (default 5 minutes), attempt limit, and per-user rate limit.
- One active challenge per user/guild; repeated requests invalidate earlier challenges.
- Manual verification by authorized staff.
- Verification can be disabled or reset; reset removes or detaches T77-managed roles/channel only after confirmation.
- Role hierarchy must permit T77 to assign/remove the unverified role; setup validates this and reports actionable errors.
- Button verification is accessible but weaker; CAPTCHA is stronger. Neither is a complete anti-bot guarantee.

### 8.7 Whitelist and trust model

**Targets:** users, roles, channels.

**Scopes:** global or a specific Anti-Nuke action. Channel whitelist applies only where the action has a channel context (for example, deletion or update of that channel); it is not a global actor exemption.

**Rules**

- Every entry has creator, creation time, reason, optional expiry, and revocation history.
- Expired entries are ignored by the engine and cleaned up by a scheduled job.
- Precedence: owner > global user > action user > global role > action role > action channel, with explicit action semantics.
- Whitelists do not grant permissions and do not suppress audit records.
- Creating, revoking, or extending critical trust entries requires owner or authorized security-admin access and a confirmation.
- Only the owner can appoint security administrators or change the enforcement approval state.
- All changes are append-only in the audit trail.

### 8.8 Moderation

**Commands:** `/ban`, `/kick`, `/timeout`, `/untimeout`, `/warn`, `/warnings`, `/unban`, `/purge`, `/lock`, `/unlock`, `/lockall`, `/unlockall`, `/slowmode`, `/softban`.

**Rules**

- A command is allowed if the actor is the owner, has the relevant Discord permission and is above the target, or has the relevant T77 grant and is above the target. Custom grants never bypass hierarchy.
- T77 verifies both actor hierarchy and bot hierarchy before acting.
- Every action creates a moderation case with a per-guild case number, reason, moderator ID, target ID, duration, and source.
- Sensitive actions use confirmation buttons with expiries: mass purge, lockall/unlockall, softban with message deletion, and destructive moderation.
- Bans and kicks are not reversible. Timeouts, locks, slowmode, unban, and warnings have explicit reversible paths.
- T77's own moderation actions are recorded as moderator-attributed security events so custom-permission abuse is observable.
- Anti-Nuke policies may constrain moderation volume if enforcement is enabled; this is configurable and warned about during setup.
- Discord audit log reason format: `T77 | Case #<id> | <reason>`.

### 8.9 Backup and recovery

**Snapshot scope**

- Guild metadata available through the API: name, icon/banner assets where downloadable, verification level, content filter, notification settings, AFK/system/rules channels, locale.
- Roles: name, color, hoist, mentionable, permissions, position, icon where supported.
- Channels: type, name, parent, position, topic, NSFW, slowmode, bitrate, user limit, permission overwrites.
- Emojis/stickers where supported and within size limits.
- Native settings that can be accurately read and restored.

**Explicitly not backed up / not restorable**

- Messages, attachments, message history, deleted content.
- Member lists or membership states.
- Audit logs.
- Webhook tokens or live webhook endpoints.
- Integration credentials.
- Invite history.
- Exact Discord IDs for recreated roles/channels.
- Any data Discord does not expose to bots.

**Storage**

- Compressed JSON snapshot plus optional asset files.
- Metadata and checksum in PostgreSQL.
- Local Docker volume by default; optional S3-compatible object storage.
- Encryption in transit; optional application-level AES-256-GCM for assets.
- Retention policy configurable: scheduled snapshots, manual snapshots, pre-restore snapshots.

**Restore**

1. User previews a diff with counts and conflicts.
2. User selects categories/targets.
3. System requires typed confirmation and permission checks.
4. A pre-restore backup is created.
5. Worker executes with progress, rate limiting, cancellation, and a final report.
6. Restored roles/channels get new IDs; permission mapping is shown, not hidden.
7. T77 never claims complete server cloning or message recovery.

### 8.10 Logging

Dedicated categories:

- Security
- Anti-Nuke
- Anti-Raid
- Moderation
- Member
- Role
- Channel
- Verification
- Bot
- Backup

Each category maps to an optional Discord channel. Logs use T77-branded embeds with timestamp, actor ID, target ID, reason, guild, incident/case reference, and source. A fallback security log is used if a category channel is missing; failures are retried and shown in dashboard health. Sensitive message content is redacted by default.

---

## 9. Dashboard and API

### Design system

- Dark near-black background, dark gray surfaces, red accent, restrained green/amber status colors.
- Original T77 shield mark, wordmark, and embed templates.
- Reusable status pills, section headers, data tables, confirmation dialogs, toasts, and form controls.
- Mobile-first responsive layout with collapsible navigation.
- Accessible focus states, labels, reduced-motion support, and sufficient contrast.
- No copied images, logos, or copy from Security Bot.

### Pages and routes

| Route | Page | Main data |
|---|---|---|
| `/` | Overview | Security score, module states, live incidents, recent cases |
| `/servers/:guildId/security` | Security Status | Posture scan, dangerous permissions, backups, degraded modules |
| `/servers/:guildId/anti-nuke` | Anti-Nuke Settings | Rules, thresholds, windows, containment, enforcement approval |
| `/servers/:guildId/anti-raid` | Anti-Raid Settings | Scores, join window, bypasses, quarantine, lockdown |
| `/servers/:guildId/beast-mode` | Beast Mode | State, score, threshold, duration, manual override |
| `/servers/:guildId/anti-spam` | Anti-Spam | Flood/duplicate/caps/mention policies |
| `/servers/:guildId/automod` | AutoMod | Banned words, domains, invites, exemptions |
| `/servers/:guildId/verification` | Verification | Mode, roles, channel, difficulty, retries |
| `/servers/:guildId/whitelist` | Whitelist | Entries, scopes, expiries, audit |
| `/servers/:guildId/moderation` | Moderation | Cases, warnings, filters, history |
| `/servers/:guildId/bot-protection` | Bot Protection | Approved bots, permission alerts, integrations |
| `/servers/:guildId/backups` | Backup and Recovery | Snapshots, schedules, restore previews |
| `/servers/:guildId/audit-logs` | Audit Logs | Dashboard and security event history |
| `/servers/:guildId/staff` | Staff Permissions | Grants, security admins, audit |
| `/servers/:guildId/settings` | General Settings | Logs, timezone, automation mode, danger zone |

### API shape

```text
GET    /api/auth/discord
GET    /api/auth/discord/callback
GET    /api/auth/session
POST   /api/auth/logout

GET    /api/guilds
GET    /api/guilds/:guildId/overview
GET    /api/guilds/:guildId/config
PATCH  /api/guilds/:guildId/config
GET    /api/guilds/:guildId/security

GET    /api/guilds/:guildId/anti-nuke
PATCH  /api/guilds/:guildId/anti-nuke
POST   /api/guilds/:guildId/anti-nuke/approval

GET    /api/guilds/:guildId/anti-raid
PATCH  /api/guilds/:guildId/anti-raid
GET    /api/guilds/:guildId/beast-mode
PATCH  /api/guilds/:guildId/beast-mode
POST   /api/guilds/:guildId/beast-mode/override

GET    /api/guilds/:guildId/automod
PATCH  /api/guilds/:guildId/automod
GET    /api/guilds/:guildId/verification
PATCH  /api/guilds/:guildId/verification

GET    /api/guilds/:guildId/whitelist
POST   /api/guilds/:guildId/whitelist
PATCH  /api/guilds/:guildId/whitelist/:entryId
DELETE /api/guilds/:guildId/whitelist/:entryId

GET    /api/guilds/:guildId/moderation/cases
GET    /api/guilds/:guildId/moderation/cases/:caseId
GET    /api/guilds/:guildId/bot-protection
PATCH  /api/guilds/:guildId/bot-protection

GET    /api/guilds/:guildId/backups
POST   /api/guilds/:guildId/backups
GET    /api/guilds/:guildId/backups/:backupId
POST   /api/guilds/:guildId/backups/:backupId/preview
POST   /api/guilds/:guildId/backups/:backupId/restore

GET    /api/guilds/:guildId/audit-logs
GET    /api/guilds/:guildId/staff
POST   /api/guilds/:guildId/staff
DELETE /api/guilds/:guildId/staff/:grantId

GET    /api/guilds/:guildId/events        (SSE)
GET    /healthz
GET    /readyz
```

### OAuth2 and sessions

- OAuth2 Authorization Code flow with `state` and PKCE.
- Scopes: `identify` and `guilds` only; no bot token, no unnecessary scopes.
- Session is an opaque, random identifier in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie. Session data and encrypted Discord tokens live server-side in Redis/PostgreSQL.
- Tokens are encrypted at rest with AES-256-GCM.
- CSRF protection for all mutating routes using a per-session token and Origin/Referer validation.
- Session rotation after login; absolute and idle expiry; logout invalidates server-side.
- Each guild request verifies:
  1. valid session,
  2. user is a member of the guild,
  3. bot is present,
  4. user has the required Discord permission or T77 grant,
  5. sensitive actions require a fresh confirmation token.
- Cached Discord guild permissions are short-lived; sensitive mutations revalidate against Discord.
- The web app never sees the bot token, client secret, database URL, or OAuth access token.

### Config write safety

- Shared Zod schemas validate every field on client and server.
- Optimistic concurrency with `configVersion`; stale writes return a conflict and require refresh.
- Critical changes require a one-time confirmation token bound to session, guild, action, and current config version.
- The API writes config and an `AuditEntry` in one transaction, then publishes a cache-invalidation event.
- Save and reset are distinct actions; reset requires confirmation.
- Validation errors are field-specific and never expose stack traces.

### Live status

- SSE from the API, backed by Redis pub/sub.
- Events: module degraded, new incident, Beast state change, verification queue, backup progress, restore progress.
- Reconnect uses `Last-Event-ID`; missed events fall back to a REST refresh.

---

## 10. Slash Commands

Top-level moderation commands:

`/ban`, `/kick`, `/timeout`, `/untimeout`, `/warn`, `/warnings`, `/unban`, `/purge`, `/lock`, `/unlock`, `/lockall`, `/unlockall`, `/slowmode`, `/softban`.

`/t77` subcommands:

| Command | Purpose |
|---|---|
| `/t77 help` | Contextual help and permissions |
| `/t77 setup` | Guided setup, role/channel checks, log channels, initial observation mode |
| `/t77 status` | Module status, degraded capabilities, enforcement state |
| `/t77 security` | Security posture summary and scan recommendations |
| `/t77 scan` | Check role hierarchy, dangerous permissions, unapproved bots, webhook exposure, missing log channels |
| `/t77 audit` | Recent incidents, events, and cases |
| `/t77 antinuke` | View/toggle rules, limits, windows, containment, approval state |
| `/t77 antiraid` | Scores, thresholds, quarantine, lockdown, manual review |
| `/t77 beast` | Status, activate/calm (owner-only emergency override) |
| `/t77 automod` | Anti-spam and content policy |
| `/t77 verification` | Setup, enable, disable, reset, manual verify |
| `/t77 whitelist` | Add, remove, list, expire, audit |
| `/t77 backup` | Create/list/schedule snapshots |
| `/t77 restore` | Preview/start/cancel/status |
| `/t77 logs` | Configure log categories and test delivery |
| `/t77 config` | View/export/reset general configuration |

**Authorization:** command visibility is not authorization. Every command and subcommand performs server-side permission, hierarchy, and guild-context checks. Custom T77 grants are evaluated for users who lack equivalent Discord permissions. Sensitive subcommands require confirmation and are audited. Destructive enforcement approval and security-admin grants are owner-only.

---

## 11. Security and Operational Controls

### Application security

- Environment validation with Zod at startup; fail fast on missing secrets.
- No secrets in source, images, logs, error responses, or client bundles.
- `.env.example` contains names and safe placeholders only.
- Helmet, strict CSP, HSTS behind TLS, secure cookies, no inline scripts.
- Rate limits: login, OAuth callback, mutations, CAPTCHA attempts, verification, moderation commands, and security actions.
- Redis-backed distributed limits for multi-instance deployments.
- CSRF and Origin checks on mutations.
- Constant-time CAPTCHA hash comparison.
- Zod validation on every config and API boundary.
- Prisma parameterized queries; no raw SQL interpolation.
- React escapes content; no `dangerouslySetInnerHTML`.
- No URL fetching from user-provided blocked-domain lists; domain matching only.
- Append-only audit entries; no update/delete endpoints for history.
- Structured error codes and request IDs; internal errors are redacted.
- Dependency and container scanning in CI.

### Discord-specific security

- Always enforce role hierarchy and owner immunity.
- Never attempt to bypass Discord rate limits, permissions, or audit log omissions.
- Ignore T77's own actions to avoid self-triggering loops.
- Use audit-log reasons for traceability.
- Treat audit log attribution as evidence, not absolute truth.
- Refuse destructive policy activation without owner confirmation.
- Quarantine and verification are preferred over bans in ambiguous cases.

### Data protection

- Store the minimum Discord identifiers necessary.
- Encrypt OAuth tokens and sensitive backup assets.
- Redact message content from logs by default.
- Retention jobs for expired whitelist entries, verification challenges, sessions, audit logs, and backup snapshots.
- Guild removal initiates configurable deletion of tenant data, preserving only legally required minimal records if any.
- Backups are access-controlled and never exposed via public URLs.

### Deployment security

- Multi-stage Docker builds, non-root users, read-only root filesystems where possible, dropped Linux capabilities.
- Separate environment secrets per service.
- `bot`/`worker` token access isolated from `api`/`web`.
- PostgreSQL and Redis not publicly exposed; private network only.
- Nginx TLS, security headers, request size limits, and same-origin reverse proxy.
- Health checks and graceful shutdown.
- `prisma migrate deploy` as an explicit deployment step.
- No production seeding of demo data.

---

## 12. Testing Strategy

### Unit tests

- Pure Anti-Nuke threshold engine: below/at/above threshold, window boundaries, decay, config changes, disabled rules, observation mode.
- Anti-Raid scoring: time-based joins, account age boundaries, avatar signal, badge bypass, score reset, minimum-confidence gate.
- Beast Mode: aggregation, activation, expiry, per-action authorization, no blanket punishment.
- AutoMod: flood, duplicates, mentions, caps, links, invites, banned words/domains, exemptions.
- CAPTCHA: expiry, attempt limits, hash comparison, invalidation.
- Permission resolution: owner, hierarchy, T77 grants, whitelist precedence.

### Integration tests

- Discord event normalization with mocked discord.js objects.
- Audit-log attribution from mock entries, including missing executor cases.
- Idempotency and duplicate event handling.
- Anti-Nuke incident creation and action dispatch.
- Anti-Raid incident and quarantine workflow.
- Verification button/modal flow with mocked interactions.
- Moderation case creation and hierarchy checks.
- Backup snapshot/preview/restore with mocked Discord REST.
- API routes with Supertest.
- Database migrations with Testcontainers PostgreSQL and Redis.
- Cross-tenant isolation attempts.

### Dashboard tests

- OAuth state/PKCE validation.
- Session cookie flags, expiry, rotation, and logout.
- CSRF rejection.
- Guild permission and staff grant checks.
- Unauthorized guild access.
- Config validation, optimistic concurrency, critical confirmation.
- Playwright smoke tests for all 15 pages at desktop and mobile widths.

### Live Discord tests

- Optional and explicitly gated by `ALLOW_LIVE_DISCORD_TESTS=true`.
- Run only against a private test guild with dedicated test accounts/bots.
- Never run destructive tests against public servers.
- Destructive policies remain disabled during automated tests.

### CI gates

- Typecheck, lint, unit tests, integration tests, build.
- Prisma migration validation.
- Dashboard build and Playwright smoke.
- Dependency audit and secret scan.
- No merge if security-engine or authorization tests fail.

---

## 13. Deployment and Operations

### Docker Compose services

- `postgres` — persistent volume, private network.
- `redis` — persistent AOF where appropriate, private network.
- `bot` — gateway and interaction process.
- `worker` — BullMQ job processors and schedulers.
- `api` — Express API.
- `web` — static frontend served by Nginx/reverse proxy.
- `migrate` — one-shot Prisma migration runner.
- Optional `backup-storage` — local volume or external S3-compatible bucket.

### Environment variables (`.env.example`, names only)

```text
NODE_ENV
APP_NAME
APP_URL
API_BASE_URL
WEB_ORIGIN

DISCORD_TOKEN
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
DISCORD_REDIRECT_URI
DISCORD_DEV_GUILD_ID

DATABASE_URL
REDIS_URL

SESSION_SECRET
ENCRYPTION_KEY
CAPTCHA_SECRET

LOG_LEVEL
METRICS_TOKEN

BACKUP_STORAGE_TYPE
BACKUP_LOCAL_DIR
S3_ENDPOINT
S3_REGION
S3_BUCKET
S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY

ALLOW_LIVE_DISCORD_TESTS
```

No real credentials are committed. `ENCRYPTION_KEY` and `SESSION_SECRET` must be generated with a cryptographically secure random source and rotated via a documented procedure.

### Scaling path

- Initial deployment: one bot process and one worker; Redis-backed counters and rate limits.
- Larger deployments: discord.js sharding, multiple shards, shared Redis/Postgres, separate workers.
- No in-memory security counters as source of truth.
- Backups/restores are serialized per guild with Redis locks.
- Rate limits and idempotency survive process restarts.

### Observability

- Structured JSON logs with request ID, guild ID, actor ID, incident ID, case ID (never secrets or raw message content).
- Health and readiness endpoints.
- Metrics for gateway latency, queue depth, failed actions, log delivery failures, degraded modules, backup failures.
- Alerting for Redis/Postgres outage, repeated 429s, and disabled enforcement.

---

## 14. Technical Limitations and Honest Non-Goals

1. **Audit log attribution is not guaranteed.** Discord audit entries can be delayed, missing, pruned after roughly 45 days, or lack an executor. T77 will alert with "unknown actor" rather than punish based on a guess.
2. **A bot cannot exceed its permissions or role hierarchy.** It cannot punish the owner or members with roles above its own, and a compromised higher administrator can still damage the server.
3. **Burst detection is not instantaneous.** Gateway delivery, audit log latency, and Discord rate limits mean protection is best-effort, not a firewall.
4. **There is no API to fully pause joins.** T77 can delete invites and raise verification requirements where supported, but vanity URLs or existing invites may still permit joins. The UI will state this.
5. **Backups cannot restore messages, members, audit logs, webhook tokens, integrations, or exact IDs.** Recreated roles and channels receive new IDs. Restores are selective and best-effort.
6. **Anti-Raid signals are weak individually.** Account age, avatar, and join speed can produce false positives. T77 defaults to quarantine/verification, not bans, and requires explicit destructive approval.
7. **CAPTCHA is not invulnerable.** Determined humans can solve it, and button verification is intentionally weaker. Layer verification with anti-raid.
8. **Message-content automod requires the privileged intent.** Without it, content-based checks are reported as unavailable.
9. **Webhook abuse has limited attribution.** T77 can detect webhook creation and alert/remove the webhook, but cannot reliably attribute individual webhook messages to a human.
10. **T77's moderation actions appear in Discord audit logs as the bot.** T77 separately records the moderator and case, and writes a detailed audit reason.
11. **Some Discord features are not backed up or controllable.** Native AutoMod rules, integrations, and certain server settings may be only partially observable.
12. **Beast Mode is intentionally not a blanket punishment system.** It will not punish every moderator merely because it activates. This is a safety requirement, not a missing feature.
13. **Docker Compose is a single-host reference deployment.** High availability requires managed PostgreSQL/Redis, multiple workers, and a sharding plan.
14. **No premium/entitlement system is included.** All scoped features are core product features; there is no fake paywall.
15. **No external CAPTCHA service is used by default.** CAPTCHA images are generated locally to avoid third-party dependencies and data sharing.

---

## 15. Phase Plan and Acceptance Gates

### Phase 2 — Project initialization and bot core

- pnpm monorepo, strict TypeScript, lint/format, env validation, Docker baselines.
- Discord client, intents, graceful shutdown, command registry, interaction router.
- T77 design primitives: shield, color tokens, embeds, errors, success messages.
- `/t77 help`, `/t77 status` (real data only), health checks.
- Tests: startup/env validation, command registration, interaction routing.
- Gate: bot connects to a test guild, command works, no secrets logged, CI green.

### Phase 3 — Database and persistence

- Prisma schema, initial migrations, tenant guard, repositories, config versioning, audit entries.
- Guild bootstrap on join; resource sync for dashboard selectors.
- Redis cache and pub/sub foundation.
- Tests: migrations, tenant isolation, config audit, repository behavior.
- Gate: multi-guild configs remain isolated; migrations apply cleanly.

### Phase 4 — Anti-Nuke and bot/permission protection

- Event normalization, audit-log resolver, deduplication.
- Action catalog, thresholds/windows, risk tracking, observation mode.
- Owner approval flow for reversible/destructive enforcement.
- Alerts, incident records, punishment dispatcher, hierarchy safeguards.
- Bot add and dangerous-permission monitoring.
- Tests: thresholds, false positives, idempotency, missing executor, cross-guild.
- Gate: observation mode detects and logs simulated nukes without changing the guild; approved test containment works in a private guild.

### Phase 5 — Anti-Raid and Beast Mode

- Join scoring, aggregate windows, quarantine, verification hook, invite lockdown, manual release.
- Beast score aggregation, activation, per-action scrutiny, owner override, incident history.
- Tests: raid false positives, single-signal protection, Beast no-blanket-punishment.
- Gate: simulated raid triggers quarantine/alert but not auto-ban; Beast activation does not punish authorized staff.

### Phase 6 — AutoMod and verification

- Anti-spam engine, content checks, exemptions, timeout/warn policies.
- Unverified role, verification channel, button/CAPTCHA, retries, manual verify, logs.
- Tests: all detections, exemptions, CAPTCHA expiration/attempts, permission failures.
- Gate: content-free intent degradation is visible; a real test member can verify via button and CAPTCHA.

### Phase 7 — Moderation and whitelist

- All moderation commands, case IDs, warnings, confirmations, reversibility, audit reasons.
- T77 staff grants, whitelist CRUD/expiry/history, owner-only critical controls.
- Tests: permissions, hierarchy, case sequencing, whitelist precedence, cross-tenant.
- Gate: custom-granted moderator can act within hierarchy; unauthorized user cannot; cases and logs match.

### Phase 8 — Backup and recovery

- Snapshot capture, schedulers, retention, object storage adapter, previews, selective restore, progress.
- Pre-restore backups, confirmation, cancellation, limitations surfaced in UI.
- Tests: snapshot schema, mapping, restore with mocked Discord, retention.
- Gate: backup/preview/selective restore works in a private test guild without claiming message recovery.

### Phase 9 — Web dashboard

- OAuth2 with PKCE, secure sessions, permission middleware, REST APIs, SSE.
- All 15 pages, T77 design system, forms, confirmations, responsive layout, live indicators.
- Tests: auth, CSRF, tenant isolation, config writes, Playwright smoke.
- Gate: every page loads real data from the API; unauthorized access is rejected; no bot token in browser.

### Phase 10 — Testing, security review, documentation, deployment

- Full test suite, CI, dependency/secret scans, threat-model review.
- Deployment docs, runbook, `.env.example`, backup/restore operational guide.
- Final security review: OAuth, cookies, CSRF, rate limits, permission checks, audit logging.
- Gate: build, tests, migrations, and Docker Compose smoke pass; limitations and runbooks are accurate.

---

## 16. Assumptions Requiring Approval

1. Project will live in `t77/` inside the current workspace.
2. Node.js 24 LTS and the pinned package versions above are acceptable.
3. Default CAPTCHA is T77-generated image CAPTCHA plus an optional button mode; no third-party CAPTCHA provider.
4. Initial deployment target is Docker Compose on one host, with a documented scaling path; no Kubernetes/cloud-provider-specific implementation.
5. Backups use local Docker volume by default, with an optional S3-compatible adapter.
6. Initial implementation is single-shard; sharding-ready design, not a day-one sharded deployment.
7. No premium/entitlement system is required.
8. The dashboard is a React SPA served from the same origin as the API behind a reverse proxy.

---

## 17. Phase 1 Deliverable Status

- Architecture, safety model, data model, file structure, command map, testing strategy, deployment strategy, and limitations: **defined in this document**.
- Implementation code: **not started**, intentionally.
- Next action: approve or adjust the assumptions above, then proceed to Phase 2 (project scaffold and bot core).

---

## 18. Phase 2 Implementation Notes

Phase 2 was approved and implemented. The detailed file inventory and verification results are in [`02-phase-2.md`](02-phase-2.md).

Technical changes from the original plan:

- **TypeScript 5.9.3** is pinned because the current `typescript-eslint` release supports TypeScript `<6.1.0`. The workspace runs on Node 26 locally and Node 24 in the Docker image.
- **Bot health service added early.** T77 exposes loopback `/healthz` and `/readyz` endpoints so Docker and future orchestration have a real readiness signal instead of a trivial process-exit health check.
- **Command registration state is runtime-visible.** Registration scope, status, count, timestamp, and sanitized failure state are stored on the client and shown by `/t77 status` and `/readyz`.
- **Only implemented packages were scaffolded.** `apps/api`, `apps/web`, `apps/worker`, Prisma, and Redis code remain for their assigned phases; empty placeholder applications were deliberately not created.
- **Docker deploy uses `pnpm deploy --legacy`.** pnpm 10 requires injected workspace packages for the default deploy path; the bot bundle already includes `@t77/shared`, so the legacy deploy path is sufficient and avoids changing the whole workspace's install semantics.
- **Docker verification is pending.** Docker is not installed in the current environment. Compose syntax, the bot build, and the deployed production layout were validated locally without starting containers.
- **Command authorization remains server-side.** `/t77 help` is available to server members; `/t77 status` requires the owner or Manage Server. Future custom T77 grants will extend this without bypassing Discord role hierarchy.

---

## 19. Phase 3 Implementation Notes

Phase 3 was implemented and validated. The full design, tests, and limitations are in [03-phase-3.md](03-phase-3.md).

Key decisions that refine the original plan:

- **Prisma 7 driver adapter.** PostgreSQL access uses `@prisma/adapter-pg` with explicit pool size, connect timeout, and statement timeout. The generated client lives in `packages/db/src/generated/prisma` and is not committed.
- **Tenant guard at the repository boundary.** Every repository requires an immutable `TenantContext`; there is no per-operation guild ID parameter. `updateMany` predicates include both the row ID and `guildId` as defense in depth.
- **Audit immutability is dual-enforced.** The repository has no update/delete API, and a PostgreSQL trigger rejects `UPDATE`, `DELETE`, and `TRUNCATE`.
- **Configuration uses optimistic versioning.** Writes increment `version` and append the audit diff in the same transaction. Stale versions raise a typed conflict.
- **Moderation numbering is serialized per guild.** `SELECT ... FOR UPDATE` on the guild row, followed by the sequence increment and case insert, prevents duplicate case numbers.
- **Redis uses separate command and subscriber connections.** Subscribed connections cannot issue normal commands. Cache envelopes are guild-bound; Pub/Sub subscribers re-check the guild ID before invoking handlers.
- **Bot startup is dependency-gated.** PostgreSQL and Redis must connect before Discord login, and `/readyz` reports both. Guilds are bootstrapped on join and reconciled on ready.
- **RLS remains deferred.** Application-level tenant guards are tested exhaustively; database-enforced per-session RLS is documented as a future defense-in-depth step because it requires a dedicated role and session-variable plumbing.
- **Docker and live-gateway verification remain pending.** Docker is unavailable in this environment, and no Discord credentials/private test guild were provided. Compose, Dockerfile, type checks, builds, unit tests, and database/Redis integration tests were validated locally.

---

## 20. Phase 4 Implementation Notes

Phase 4 was implemented and validated against its automated acceptance criteria. The full design, tests, and limitations are in [04-phase-4.md](04-phase-4.md).

Key decisions that refine the original plan:

- **A pure `@t77/security-core` package owns detection.** The action catalog, sliding windows, risk scoring, exemption ordering, and response policy have no Discord.js, Prisma, or network dependency. This makes threshold and false-positive behavior deterministic and unit-testable.
- **Audit log is primary; gateway events are evidence-only fallbacks.** `GuildAuditLogEntryCreate` produces `CERTAIN` attribution. Gateway fallbacks retry the audit log with a bounded resolver; if the entry never appears they emit an `UNCERTAIN` event that is recorded and alerted but never attributed to a member or counted toward a punishment.
- **A two-event minimum is enforced in the engine constructor.** It cannot be configured below two, and uncertain attribution never counts. This is stronger than a per-rule threshold alone.
- **Response policy is a separate pure function.** Mode, owner approval, destructive approval, hierarchy, cooldown, attribution, and event count are evaluated in a fixed order and return an explicit block reason plus `wouldHaveActed`.
- **Owner immunity is defence in depth.** It is checked by the engine exemption, the coordinator decision, and the Discord dispatcher. Hierarchy is also re-checked at dispatch time, not only at evaluation time.
- **Containment is idempotent and rate-limited.** Punishments use durable idempotency keys, and the dispatcher adds an in-memory duplicate guard plus a per-actor action rate limit to prevent loops.
- **`WEBHOOK_DELETE` was added to the action enum.** Webhook deletion is destructive and is now monitored with its own migration (`20261114160000_phase4_webhook_delete`).
- **Quarantine is wired but not configurable yet.** The dispatcher supports quarantine, but the role ID lives in `AntiRaidConfig` and is deferred to Phase 5. Until then quarantine fails cleanly with `QUARANTINE_ROLE_NOT_CONFIGURED` rather than silently doing nothing.
- **Commands are real and scoped.** `/t77 antinuke` exposes status, per-rule editing, owner-only approval/revocation, and trust management; `/t77 logs` routes categories to validated text-capable channels. Enforcement approval requires the recorded guild owner, even if a staff member has Manage Server.
- **In-memory windows are a cache, not the ledger.** Every event is persisted in PostgreSQL with a dedupe key; short-window counters reset on restart. Redis-backed counters remain a future hardening step.
- **Live containment and Docker remain unverified.** Automated tests cover every monitored action, thresholds, delayed/missing audit logs, exemptions, hierarchy, multiple actors, and response loops. No bot credentials/private test guild or Docker runtime were available, so approved containment in a live server and Compose execution are documented as pending acceptance rather than claimed.

---

## 21. Phase 5 Implementation Notes

Phase 5 was implemented and validated against its automated acceptance criteria. The full design, tests, and limitations are in [05-phase-5.md](05-phase-5.md).

Key decisions that refine the original plan:

- **Raid detection is a pure, multi-signal engine.** `@t77/security-core` scores join velocity, account age, missing avatar, similar account creation times, suspicious usernames, and bot joins. Account age alone is blocked by a dedicated `ACCOUNT_AGE_ONLY` reason, and a single signal can never produce containment because `minimumSignals` is evaluated separately from the weighted score.
- **Redis became the shared source of truth for short windows.** Phase 4's in-memory counters were replaced by atomic Lua-backed sorted sets in `packages/db/src/realtime`. Anti-Nuke, Anti-Raid, and Beast Mode all use guild-first, validated keys with bounded TTLs. The synchronous `evaluate()` path is retained for deterministic tests, while production uses `evaluateWithStore()`.
- **Redis failure degrades rather than guesses.** Anti-Nuke falls back to its in-memory engine with a documented cross-restart undercount risk. Anti-Raid and Beast Mode skip evaluation and log the failure, because an incomplete join or contribution window cannot safely produce a verdict.
- **Quarantine is the default raid containment.** Auto-ban remains off, requires `autoBanEnabled`, a destructive automation mode, and recorded owner approval. Lockdown is advisory only: a confirmed raid sets `lockdownRecommended`, and T77 never closes channels or raises verification settings automatically.
- **Quarantine is a persisted lifecycle, not a transient role edit.** `QuarantineEntry` records the guild, member, role, incident, reason, verification requirement, and application/release metadata. Releasing removes only the quarantine role; roles stripped earlier are not silently restored, and automatic verification-driven release is deferred to Phase 6.
- **Beast Mode has no punishment surface.** `BeastPorts` exposes score, state, incident, and publication methods only. Only unauthorized, attributable, counted actions contribute; the owner, whitelisted actors, and authorized staff contribute nothing. Activation opens heightened monitoring and an incident, never group punishment.
- **Beast Mode is per-actor at its core.** `evaluateBeastActor` and `transitionBeastState` are pure functions, and the Anti-Nuke `onDecision` hook contributes only when a decision is counted, unexempted, and attributable. This preserves the Phase 4 safety gate instead of bypassing it.
- **Raid and Beast incidents are durable and coalesced.** `IncidentRepository.findOpenByTypeSince` supports one open `RAID` incident per guild and window and a single `BEAST_MODE` incident, with score/severity updates rather than incident spam.
- **Commands are real and scoped.** `/t77 antiraid` exposes status, configure, quarantine, release, and list; `/t77 beast` exposes status, configure, activate, and deactivate. Both use the shared `CommandSecurityRuntime` and the same owner/Manage Server/grant authorization model as `/t77 antinuke`.
- **Live drills and Docker remain unverified.** No bot credentials or private test guild are available, so join bursts, real quarantine role assignment, and Beast activation were validated with typed fakes plus PostgreSQL/Redis integration tests. Destructive enforcement must stay disabled until a private-guild drill is completed.

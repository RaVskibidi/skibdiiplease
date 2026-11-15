# T77 — Phase 5: Anti-Raid and Beast Mode

**Status:** Implemented and validated against its automated acceptance criteria. Destructive enforcement remains disabled pending private-guild verification.
**Scope:** join-velocity monitoring, multi-signal raid risk scoring, verification-gated quarantine, Redis-backed security counters, durable raid incidents, Beast Mode risk aggregation and heightened monitoring, emergency protection settings, and the `/t77 antiraid` and `/t77 beast` commands.

---

## 1. Design goals

Phase 5 closes the Phase 4 hardening gaps without turning uncertainty into punishment.

The implementation follows these invariants:

1. **Observation is the default.** Anti-Raid records, scores, opens incidents, and alerts, but containment requires recorded owner approval and a non-observe automation mode.
2. **Account age is never sufficient.** A raid verdict cannot be produced by `YOUNG_ACCOUNT` alone; this is enforced by a dedicated `ACCOUNT_AGE_ONLY` block reason in the pure engine.
3. **A single signal is never sufficient.** `minimumSignals` must also be met, and join velocity itself is only one signal.
4. **Quarantine is the default containment.** Auto-ban is off by default and requires destructive mode plus explicit policy enablement.
5. **Lockdown is advisory.** T77 never closes channels or raises verification automatically. A confirmed raid sets `lockdownRecommended`, and an operator decides.
6. **Beast Mode never punishes a group.** Activation opens heightened monitoring and an incident. Authorized staff, whitelisted actors, and the server owner never contribute to the score and are never punished because Beast Mode is active.
7. **Every action remains per-actor.** Beast Mode does not change the Anti-Nuke safety gate; each dangerous action is still attributed, exempted, scored, and hierarchy-checked independently.
8. **Counters are shared and durable.** Phase 5 replaces the in-memory-only rolling windows with atomic Redis sorted sets and Lua scripts. PostgreSQL remains the audit ledger.
9. **Redis failure degrades safely.** Anti-Nuke falls back to its in-memory engine; Anti-Raid and Beast Mode skip evaluation and log the failure rather than guessing.
10. **Durable lifecycle.** Quarantines, raid incidents, Beast state, settings, and every activation/override are persisted and audited.

---

## 2. Architecture

```text
GuildMemberAdd (human)
        │
        ▼
AntiRaidCoordinator ──▶ RaidJoinWindowStore (Redis ZSET, Lua)
        │                        │
        │                        ▼
        │               evaluateRaidJoin (pure, multi-signal)
        │                        │
        │              ┌─────────┴──────────┐
        │              ▼                    ▼
        │        RAID incident        decision + response gate
        │        (RAID type)                 │
        │                          ┌─────────┴──────────┐
        │                          ▼                    ▼
        │                     quarantine            alert + publish
        │                     (role + entry)
        │
GuildAuditLogEntryCreate
        │
        ▼
AntiNukeCoordinator ──▶ RedisAntiNukeCounterStore (Lua)
        │
        ├──▶ Anti-Nuke decision (unchanged Phase 4 gate)
        │
        └──▶ onDecision ──▶ BeastCoordinator ──▶ BeastStateStore (Redis)
                                  │
                                  ├──▶ Beast score (decayed, unauthorized only)
                                  ├──▶ activation + BEAST_MODE incident
                                  └──▶ alert + publish
```

### Pure core additions: `packages/security-core`

| File | Responsibility |
|---|---|
| `src/anti-raid/types.ts` | Raid signals, policy, decision, block reasons, defaults |
| `src/anti-raid/engine.ts` | `evaluateRaidJoin`: velocity, age, avatar, similar-age, username signals and the response gate |
| `src/beast-mode/engine.ts` | `evaluateBeastActor`, `computeBeastScore`, `transitionBeastState` |
| `src/anti-nuke/types.ts` | Counter-store and snapshot contracts used by the Redis path |

### Redis state: `packages/db/src/realtime`

| File | Responsibility |
|---|---|
| `keys.ts` | Validated, guild-first key names for every security counter |
| `anti-nuke-counters.ts` | Atomic prune + record + read for windows and risk, enforcement cooldowns |
| `raid-window.ts` | Bounded join-velocity window shared across shards |
| `beast-state.ts` | Contribution window plus TTL-bound Beast state projection |

### Bot coordinators

| File | Responsibility |
|---|---|
| `apps/bot/src/security/anti-raid/coordinator.ts` | Join intake, exemption resolution, incident coalescing, quarantine, alerting |
| `apps/bot/src/security/anti-raid/prisma-ports.ts` | Tenant-scoped Anti-Raid persistence adapters |
| `apps/bot/src/security/beast-mode/coordinator.ts` | Beast scoring, automatic activation/expiry, manual override, per-actor evaluation |
| `apps/bot/src/security/beast-mode/prisma-ports.ts` | Tenant-scoped Beast persistence adapters |
| `apps/bot/src/events/anti-raid.ts` | Human `GuildMemberAdd` intake |
| `apps/bot/src/bootstrap/application.ts` | Wires stores, coordinators, the Beast hook, and the command security runtime |

---

## 3. Anti-Raid detection

### Signals

| Signal | Default weight | Meaning |
|---|---:|---|
| `JOIN_VELOCITY` | 30 | joins inside the window meet `aggregateThreshold` |
| `YOUNG_ACCOUNT` | 25 | account age is below `minimumAccountAgeDays` |
| `NO_AVATAR` | 15 | member has no custom avatar |
| `SIMILAR_ACCOUNT_AGE` | 20 | another recent join was created within 24 hours of this account |
| `SUSPICIOUS_USERNAME` | 15 | username matches automated patterns (invite spam, long digit runs, repeated characters) |
| `BOT_ACCOUNT` | — | recorded, but bot additions are owned by Anti-Nuke's `BOT_ADD` rule |

Weights are configurable per guild. The score is capped at 100.

### Default policy

| Setting | Default | Rationale |
|---|---|---|
| `enabled` | `true` | evaluation is safe and observational |
| `joinWindowSeconds` | `60` | short burst window |
| `aggregateThreshold` | `10` | velocity needs a real burst |
| `minimumSignals` | `2` | one weak signal never suffices |
| `minimumAccountAgeDays` | `7` | age boundary for the age signal |
| `riskThreshold` | `60` | weighted score required for a verdict |
| `quarantineEnabled` | `true` | preferred reversible containment |
| `lockdownEnabled` | `false` | lockdown is advisory and opt-in |
| `autoBanEnabled` | `false` | destructive automation disabled |
| `verificationRequired` | `true` | quarantine is verification-gated |
| `bypassBadges` | `[]` | optional public-badge bypass |

### Decision gate

A raid response is blocked when any of the following holds:

- Anti-Raid or the policy is disabled (`RAID_DISABLED`);
- the join is not part of a raid (`THRESHOLD_NOT_MET`);
- only the account-age signal fired (`ACCOUNT_AGE_ONLY`);
- fewer independent signals than configured (`INSUFFICIENT_SIGNALS`);
- the member is the owner, globally/action whitelisted, authorized staff, or badge-bypassed (`WHITELISTED`);
- the join is a bot (`BOT_ACCOUNT`);
- quarantine is disabled and no ban is requested (`QUARANTINE_DISABLED`);
- the guild is observing (`OBSERVE_MODE`);
- owner approval is missing (`OWNER_APPROVAL_REQUIRED`);
- auto-ban is requested but not enabled, or the mode is not destructive (`AUTO_BAN_DISABLED`, `OWNER_APPROVAL_REQUIRED`).

Every blocked decision still records `wouldHaveActed` and a stable block reason.

### Response

- `QUARANTINE` assigns the configured quarantine role through the shared dispatcher, then persists a `QuarantineEntry` with the incident reference and `requiresVerification`.
- `BAN` can only occur with `autoBanEnabled`, `ENFORCE_DESTRUCTIVE`, recorded owner approval, and the full multi-signal gate.
- `ALERT` records the event, incident, and log entry without changing Discord state.
- `lockdownRecommended` is exposed in the alert and incident metadata; T77 has no automatic lockdown path.
- Raid incidents are coalesced into one open `RAID` incident per guild within a 10-minute window, with the highest score and current severity retained.

### Quarantine lifecycle

1. `/t77 antiraid configure quarantine-role:@Role` selects a normal, unmanaged role.
2. Raid containment or `/t77 antiraid quarantine` applies the role and writes an `ACTIVE` entry.
3. `/t77 antiraid release` removes the role and marks the entry `RELEASED` with the operator and reason.
4. `/t77 antiraid list` shows active quarantines.

Releasing a quarantine removes only the quarantine role. Roles that were previously stripped are **not** restored automatically; staff must reassign them after review.

Verification-driven release is intentionally not automated in Phase 5. The entry records `requiresVerification`, and the verification workflow in Phase 6 will consume it.

---

## 4. Beast Mode

### Scoring

- Only unauthorized, attributable, counted actions contribute.
- Authorized staff, whitelisted actors, and the server owner contribute zero.
- Contributions decay linearly over a 15-minute window.
- The score is an aggregate server risk signal, not a per-actor guilt score.

### Activation and expiry

- Automatic activation occurs when the aggregate score reaches the configured threshold (default `100`).
- Activation writes `BeastModeState.active`, score, expiry (default 60 minutes), incident, actor, and reason.
- Expiry deactivates Beast Mode and resets the score.
- Manual `/t77 beast activate` and `/t77 beast deactivate` require a security operator and write an audit record.
- Activation opens or updates a `BEAST_MODE` incident and sends a branded alert to `BEAST_MODE` → `SECURITY` → `ANTI_NUKE`.

### No blanket punishment

`BeastPorts` exposes no punishment method. The coordinator cannot ban, kick, timeout, or strip roles. Its only outputs are score updates, state changes, incidents, alerts, and per-actor scrutiny flags. This is an architectural guarantee, not a policy convention.

### Emergency protection

`emergencyLockdown` is an advisory setting. When enabled, activation records a recommendation and the alert states that an owner must confirm any destructive or restrictive action. T77 never closes a guild automatically.

---

## 5. Redis-backed security state

| Key family | Shape | TTL |
|---|---|---|
| `…:antinuke:window:<actor>:<action>` | sorted set of event timestamps | window + 60s |
| `…:antinuke:risk:<actor>` | sorted set of `timestamp:weight:eventId` | risk window + 60s |
| `…:antinuke:cooldown:<actor>[:<action>]` | string marker | configured cooldown |
| `…:antiraid:joins` | sorted set of join records | window + 60s, capped at 2 000 joins |
| `…:beast:contributions` | sorted set of contributions | risk window + 60s, capped at 5 000 |
| `…:beast:state` | JSON projection | activation duration + 60s |

Every key is guild-first and validates guild IDs, actor snowflakes, and action names before construction. Prune, record, and read happen in one Lua script per event, so two shards cannot observe a partially applied counter.

Anti-Nuke records enforcement cooldowns after a decision with an effective containment. If Redis fails, the coordinator logs a warning and falls back to the in-memory engine, so monitoring continues with a documented undercount risk across restarts.

---

## 6. Persistence

Migration: `20261114185927_phase5_raid_beast`.

Schema additions:

- `AntiRaidConfig`: signal weights, minimum signals, risk threshold, quarantine/lockdown/auto-ban flags, verification requirement, bypass badges, quarantine role.
- `BeastModeState`: enabled, threshold, duration, emergency lockdown, active state, score, activation/expiry, incident, activated-by, activation reason, deactivation/override metadata.
- `QuarantineStatus` enum: `ACTIVE`, `RELEASED`, `EXPIRED`.
- `QuarantineEntry`: guild, user, role, incident, status, reason, verification requirement, application and release audit fields.

Repository additions:

| Repository | Methods |
|---|---|
| `AntiRaidRepository` | `getOrCreate`, `update` with strict validation and audit |
| `BeastModeRepository` | `getOrCreate`, `updateSettings`, `activate`, `updateScore`, `deactivate` |
| `QuarantineRepository` | `apply` (one active entry per user), `release`, `findActiveByUser`, `listActive`, `countActive` |
| `IncidentRepository` | `findOpenByTypeSince` for raid/Beast incident coalescing |

`GuildServices` now exposes `antiRaid`, `beastMode`, and `quarantine` alongside the Phase 4 repositories.

---

## 7. Commands

### `/t77 antiraid`

| Subcommand | Access | Purpose |
|---|---|---|
| `status` | Everyone in a server | Mode, policy, quarantine role, active quarantines and open raid incidents |
| `configure` | Security operator | View or change thresholds, signal weights, quarantine role, lockdown/auto-ban flags |
| `quarantine` | Security operator | Manually quarantine a member for review |
| `release` | Security operator | Remove the quarantine role and close the entry |
| `list` | Security operator | List active quarantines |

### `/t77 beast`

| Subcommand | Access | Purpose |
|---|---|---|
| `status` | Everyone in a server | State, score, expiry, emergency setting, open Beast incidents |
| `configure` | Security operator | Enable, threshold, duration, emergency-lockdown recommendation |
| `activate` | Security operator | Start monitoring-only Beast Mode with a reason |
| `deactivate` | Security operator | End heightened monitoring with a reason |

Security operator means the owner, **Manage Server**, or an explicit security grant, consistent with `/t77 antinuke`. Command visibility is not authorization.

---

## 8. Alerts and publication

- Raid alerts are routed `ANTI_RAID` → `SECURITY` → system channel; Beast alerts `BEAST_MODE` → `SECURITY` → `ANTI_NUKE` → system channel.
- Raid alerts show recent join count, score, independent signals with weights, verification requirement, quarantine role, effective action, and block reason.
- Beast alerts state explicitly that activation is monitoring-only and that staff/owner actions are excluded.
- Pub/Sub events: `security.raid.detected`, `security.incident.opened`, `security.incident.updated`, `security.alert.sent`, `security.beast.activated`, `security.beast.deactivated`.
- Delivery is best-effort; a missing or failed channel never blocks the durable event, incident, or quarantine write.

---

## 9. Tests

| Suite | Count | Coverage |
|---|---:|---|
| `packages/security-core/test/anti-raid/engine.test.ts` | 15 | velocity, age, avatar, similar-age, username, multi-signal gate, account-age-only block, whitelist, observe/approval/destructive gates, lockdown advisory |
| `packages/security-core/test/beast-mode/engine.test.ts` | 13 | per-actor contributions, owner/staff exclusion, decay, activation, expiry, disabled policy |
| `apps/bot/test/anti-raid-coordinator.test.ts` | 9 | bot joins, quiet joins, observe burst, approved quarantine, account-age-only, whitelist, manual quarantine, missing role, disabled policy |
| `apps/bot/test/beast-coordinator.test.ts` | 6 | owner/staff exclusion, activation, expiry deactivation, manual override, per-actor evaluation |
| `packages/db/test/integration/phase5-security.test.ts` | 7 | Anti-Raid defaults/edits/validation, Beast lifecycle and isolation, quarantine lifecycle, tenant isolation, incident coalescing |
| `packages/db/test/integration/phase5-realtime.test.ts` | 6 | atomic Anti-Nuke windows, pruning, guild isolation, enforcement cooldown, raid window, Beast state |

Current totals:

- `packages/security-core`: 52 tests passing.
- `apps/bot`: 121 tests passing.
- `packages/db` unit: 23 passing.
- `packages/db` integration: 50 passing, including all Phase 4 and Phase 5 suites.

Validation run locally:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm format:check
TEST_DATABASE_URL='postgresql://t77@127.0.0.1:55432/t77_test?schema=public' \
TEST_REDIS_URL='redis://127.0.0.1:56379/15' \
pnpm --filter @t77/db test:integration
```

The integration runner applied all four migrations to a clean database and passed against portable PostgreSQL 16.12 and Redis 5.0.14.

---

## 10. Known limitations

1. **Live Discord verification is still pending.** No bot credentials or private test guild are available. Gateway joins, real role assignment, quarantine release, and log delivery are covered by typed mocks and database/Redis integration tests, not a live server.
2. **Docker Compose remains unexecuted.** Docker is not installed in this environment. The image and Compose file are syntax-checked only.
3. **Destructive enforcement is disabled.** Automatic bans and any destructive action must remain off until a private-guild drill verifies hierarchy, permissions, rate limits, and operator approval.
4. **Lockdown is advisory only.** Discord has no complete "pause joins" API; T77 recommends lockdown rather than silently changing server settings.
5. **Quarantine release does not restore stripped roles.** Operators must reassign roles after review. This is disclosed in the command response.
6. **Verification-driven release is Phase 6.** Phase 5 records `requiresVerification` and provides manual release; it does not yet listen for a verification success event.
7. **Redis outage reduces accuracy.** Anti-Nuke falls back to per-process memory; Anti-Raid and Beast Mode skip evaluation and log the failure. Counters are shared again when Redis recovers, but the outage window can undercount.
8. **Beast Mode is not a firewall.** It increases scrutiny and raises an incident; it cannot stop a compromised administrator above T77's role.
9. **Raid signals are probabilistic.** Defaults require multiple independent signals, but coordinated human raids can still evade detection or trigger review.
10. **No dashboard controls yet.** Phase 5 is command- and event-driven; the React dashboard arrives in Phase 9.

---

## 11. Acceptance status

| Criterion | Status |
|---|---|
| Advanced raid detection across multiple independent signals | Pass (unit + integration) |
| Join velocity monitoring with shared state | Pass (Redis integration) |
| Account-age risk scoring with age-only protection | Pass |
| Multi-signal suspicious activity detection | Pass |
| Verification-gated quarantine lifecycle | Pass (manual release; automatic verification release deferred to Phase 6) |
| Configurable raid response policies | Pass |
| Beast Mode activation, expiry, and manual override | Pass |
| Emergency protection settings | Pass (advisory by design) |
| Per-actor risk evaluation and staff/owner exclusion | Pass |
| Redis-backed counters and state with TTLs and atomic operations | Pass (Redis integration) |
| Incident tracking and alerts | Pass (mocked Discord delivery) |
| Observation-only default and no false-positive auto-ban | Pass |
| Never punish based on account age alone | Pass |
| Never punish all moderators when Beast Mode activates | Pass (no punishment API exists) |
| Whitelist and permission hierarchy respected | Pass |
| Live private-guild raid and quarantine drill | **Not executed — no credentials/guild** |
| Live Beast Mode activation drill | **Not executed — no credentials/guild** |
| Docker Compose smoke | **Not executed — Docker unavailable** |

Phase 6 must not begin until the environment-dependent drills are executed, or the owner explicitly accepts them as documented limitations.

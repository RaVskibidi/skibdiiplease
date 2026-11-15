# T77 — Phase 4: Anti-Nuke and Bot/Permission Protection

**Status:** Implemented and validated for Phase 4 acceptance. Phase 5 has not started.
**Scope:** Audit-log monitoring, action normalization, deterministic thresholds and risk scoring, trusted-actor exemptions, owner-approved response policy, hierarchy-aware containment, durable incidents and audit trails, log routing, and the `/t77 antinuke` and `/t77 logs` commands.

---

## 1. Design goals

Phase 4 adds real protection without turning a single uncertain audit event into a ban.

The implementation follows these invariants:

1. **Observation is the default.** A new guild starts in `OBSERVE`; every default rule is alert-only. No Discord punishment happens until the owner explicitly approves enforcement.
2. **Two certain events minimum.** The engine refuses to produce an automatic containment from one event, even when a rule threshold is 1.
3. **Uncertain attribution never counts.** If Discord does not expose an executor, or an event comes from a gateway fallback instead of the audit log, T77 records and alerts, but does not attribute or punish.
4. **The owner is never punished.** This is enforced in the pure engine, in the coordinator, and again in the Discord dispatcher.
5. **Hierarchy is a hard stop.** An actor whose highest role is at or above T77's highest role cannot be contained by T77.
6. **Destructive automation requires explicit owner approval.** Reversible and destructive enforcement are separate modes, both recorded with the approving owner and policy version.
7. **Trusted actors are exempt, not merely deprioritized.** User/role whitelists and approved bots are checked before counting.
8. **Every decision is durable.** Events, incidents, punishments, approvals, and trust changes are persisted in PostgreSQL with an append-only audit trail.
9. **Response loops are bounded.** Duplicate audit entries, idempotency keys, per-actor rate limits, and cooldowns prevent cascades.
10. **Recovery is described honestly.** Recommendations never promise restoration of messages, memberships, webhook tokens, integrations, or exact IDs.

---

## 2. Architecture

```text
Discord gateway event              GuildAuditLogEntryCreate
        │                                   │
        ▼                                   ▼
     gateway fallback  ──────────────▶  audit resolver
        │  (retries audit log)             │
        └──────────────┬───────────────────┘
                       ▼
                 normalizer (action mapping, executor, changes)
                       │  normalized event + attribution
                       ▼
                 coordinator (bot adapter)
                       │
        ┌──────────────┼─────────────────────────┐
        ▼              ▼                         ▼
  durable event   pure engine              actor context
  (dedupe)        (thresholds, risk,       (roles, owner,
                   exemptions, policy)      bot hierarchy)
                       │
                       ▼
              decision + incident + punishment record
                       │
        ┌──────────────┼─────────────────────────┐
        ▼              ▼                         ▼
  alert embed     dispatcher               security log
  (log channels)  (hierarchy, permission,  (ANTI_NUKE →
                   idempotency, rate limit)  SECURITY → system)
```

### Pure core: `packages/security-core`

The engine is deterministic, has no Discord.js/Prisma/network dependency, and receives an injected clock.

| File | Responsibility |
|---|---|
| `src/anti-nuke/actions.ts` | Action and punishment unions, destructive punishment set, `ANTI_NUKE_ACTIONS` |
| `src/anti-nuke/catalog.ts` | 27 action definitions: risk weight, destructive flag, default threshold/window/containment/cooldown |
| `src/anti-nuke/exemptions.ts` | Ordered exemption resolution |
| `src/anti-nuke/engine.ts` | Sliding windows, decayed actor risk score, severity, cooldown, policy application |
| `src/anti-nuke/response-policy.ts` | Mode/approval/hierarchy/attribution gate before containment |
| `src/anti-nuke/types.ts` | Evaluation input, decision, rule seed, block reasons |
| `src/anti-nuke/index.ts` | Public exports |

### Bot adapter: `apps/bot/src/security/anti-nuke`

| File | Responsibility |
|---|---|
| `ports.ts` | Repository and Discord adapter interfaces used by the coordinator |
| `normalizer.ts` | Maps `GuildAuditLogsEntry` to monitored actions and attribution confidence |
| `audit-resolver.ts` | Bounded retries for delayed audit logs with freshness filtering |
| `actor-context.ts` | Resolves actor role IDs, actor/bot highest-role positions, bot-self detection |
| `coordinator.ts` | Orchestrates dedupe, evaluation, persistence, incidents, alerts, dispatch |
| `dispatcher.ts` | Executes containment with owner immunity, hierarchy, permissions, idempotency, and rate limits |
| `alerts.ts` | Builds T77-branded incident/uncertainty embeds and resolves log destinations |
| `recovery.ts` | Produces safe, non-promissory recovery recommendations |
| `prisma-ports.ts` | Tenant-scoped PostgreSQL implementations of the ports |

### Event wiring: `apps/bot/src/events/anti-nuke.ts`

- `GuildAuditLogEntryCreate` is the primary source and produces `CERTAIN` attribution when an executor exists.
- Gateway events (`guildMemberAdd` for bots, `guildBanAdd`, `channelDelete`, `roleDelete`) act as fallbacks. Each retries the audit log first; if no entry appears, T77 emits an `UNCERTAIN` event so the action is still recorded and alerted.
- The audit resolver uses a bounded retry window and ignores stale entries, so a delayed audit log is tolerated without double-counting.

---

## 3. Monitored actions

Twenty-seven actions are catalogued. All have conservative defaults and can be individually enabled, thresholded, windowed, and assigned a containment.

| Category | Actions |
|---|---|
| Members | `MEMBER_BAN`, `MEMBER_KICK`, `MEMBER_PRUNE`, `MEMBER_ROLE_UPDATE` |
| Channels | `CHANNEL_CREATE`, `CHANNEL_DELETE`, `CHANNEL_UPDATE`, `CHANNEL_PERMISSION_UPDATE` |
| Roles | `ROLE_CREATE`, `ROLE_DELETE`, `ROLE_UPDATE`, `ROLE_PERMISSION_UPDATE`, `ADMINISTRATOR_GRANT`, `DANGEROUS_ROLE_ASSIGN`, `MASS_ROLE_ASSIGN` |
| Bots | `BOT_ADD` |
| Webhooks | `WEBHOOK_CREATE`, `WEBHOOK_UPDATE`, `WEBHOOK_DELETE` |
| Server | `GUILD_UPDATE`, `VANITY_URL_UPDATE`, `INVITE_DELETE`, `EMOJI_UPDATE`, `STICKER_UPDATE` |
| Integrations | `INTEGRATION_CREATE`, `INTEGRATION_UPDATE`, `INTEGRATION_DELETE` |

Default containment for every action is `ALERT`. Thresholds are per action; destructive actions have lower thresholds and higher risk weights. For example, `MEMBER_BAN` defaults to 3 events / 60 seconds with risk weight 30, while `ADMINISTRATOR_GRANT` defaults to 1 event / 300 seconds with risk weight 45.

Normalizer-specific classification:

- `ChannelUpdate` with `permission_overwrites` changes → `CHANNEL_PERMISSION_UPDATE`; otherwise `CHANNEL_UPDATE`.
- `RoleUpdate` that adds `Administrator` → `ADMINISTRATOR_GRANT`; other permission changes → `ROLE_PERMISSION_UPDATE`; otherwise `ROLE_UPDATE`.
- `MemberRoleUpdate` with several role additions → `MASS_ROLE_ASSIGN`; an addition containing an Administrator role → `DANGEROUS_ROLE_ASSIGN`; otherwise `MEMBER_ROLE_UPDATE`.
- `GuildUpdate` with a vanity change → `VANITY_URL_UPDATE`; otherwise `GUILD_UPDATE`.
- Unsupported audit actions return `null` instead of being forced into a bucket.

---

## 4. Detection and scoring

For each `(guild, actor, action)` the engine keeps a sliding window of event timestamps. Late events older than the rule window are persisted as evidence but cannot retroactively cross a live threshold.

A separate per-actor risk score sums action risk weights with linear decay over a 15-minute default window. Severity is score-based:

| Score | Severity |
|---|---|
| `< 20` | `LOW` |
| `20–49` | `MEDIUM` |
| `50–99` | `HIGH` |
| `>= 100` | `CRITICAL` |

A destructive action that crosses its threshold promotes `MEDIUM` to `HIGH`, so a single noisy non-destructive event cannot look critical.

Threshold crossing produces `shouldAlert` and `shouldOpenIncident`. Incidents are aggregated per actor and incident type (`NUKING`, `SUSPICIOUS_BOT`, `DANGEROUS_PERMISSION`), with severity and score updates attached to the same open incident instead of creating duplicates.

The in-memory engine is a fast short-term view, not the source of truth. Every event is written to PostgreSQL before automation is considered.

---

## 5. Exemptions

Exemption resolution runs before counting:

1. Disabled rule (`RULE_DISABLED`).
2. T77 itself (`T77_SELF`).
3. Server owner (`SERVER_OWNER`).
4. Global user whitelist.
5. Per-action user whitelist.
6. Global role whitelist.
7. Per-action role whitelist.
8. Target channel whitelist where the action has a channel context.
9. Authorized staff (explicit T77 grant).
10. Approved bot (`APPROVED_BOT`, used for `BOT_ADD`).

Expired and revoked whitelist entries are ignored. Whitelists exempt only from Anti-Nuke policy; they do not grant moderation rights or hide events from the ledger.

---

## 6. Response policy and enforcement

`resolveResponsePolicy` is a strict gate. A containment happens only when all of the following hold:

- the rule threshold is met;
- the rule containment is not `ALERT`;
- attribution is `CERTAIN`;
- at least two events are counted (engine-enforced minimum);
- hierarchy does not block the actor;
- no actor/action cooldown is active;
- automation mode is not `OBSERVE`;
- owner approval is recorded;
- for destructive containment, the mode is `ENFORCE_DESTRUCTIVE`.

Otherwise the decision records the precise block reason (`THRESHOLD_NOT_MET`, `ALERT_ONLY`, `UNCERTAIN_ATTRIBUTION`, `INSUFFICIENT_EVENTS`, `HIERARCHY`, `COOLDOWN_ACTIVE`, `OBSERVE_MODE`, `OWNER_APPROVAL_REQUIRED`, `DESTRUCTIVE_MODE_REQUIRED`) and whether T77 **would have acted**.

Modes:

| Mode | Behaviour |
|---|---|
| `OBSERVE` | Count, score, alert, open incidents, record would-have-acted; never punish |
| `ENFORCE_REVERSIBLE` | Allow approved reversible containment: quarantine, role removal, timeout |
| `ENFORCE_DESTRUCTIVE` | Allow approved kick/ban for rules configured to request them |

Owner approval is written only by `GuildServices.approveEnforcement` after verifying the recorded guild owner. Non-owner attempts raise `OwnerApprovalRequiredError` (`T77_OWNER_ONLY`). Revocation immediately returns the guild to `OBSERVE` and clears the approval fields.

Containment types: `ALERT`, `QUARANTINE`, `ROLE_REMOVAL`, `TIMEOUT`, `KICK`, `BAN`.

`QUARANTINE` is implemented in the dispatcher but currently fails cleanly with `QUARANTINE_ROLE_NOT_CONFIGURED` because the quarantine role belongs to `AntiRaidConfig`, which is wired in Phase 5. The Phase 4 command therefore recommends `TIMEOUT`, `ROLE_REMOVAL`, or `ALERT` until then.

---

## 7. Dispatcher safety

Every containment re-checks, in order:

1. `ALERT` is a successful no-op.
2. Idempotency: an applied key is never applied twice.
3. Per-actor rate limit (30 seconds by default).
4. Member resolution.
5. Owner immunity.
6. Bot self-immunity.
7. Role hierarchy (actor must be strictly below the bot).
8. Required Discord permission for the chosen action.
9. Action-specific safety (managed/everyone roles excluded, timeout bounds, ban by user ID).
10. Audit reason prefix `T77 | Anti-Nuke | ...`.

Failures are recorded and reported with a stable reason such as `SERVER_OWNER`, `HIERARCHY`, `RATE_LIMITED`, `DUPLICATE_PUNISHMENT`, `MEMBER_NOT_FOUND`, or `MISSING_PERMISSION_<flag>`. T77 does not blind-retry a failed containment.

Idempotency keys and recent-action timestamps are bounded in memory. The durable punishment row is the cross-restart record; the in-memory set is an additional guard against rapid duplicates.

---

## 8. Persistence and incidents

Phase 4 reuses the Phase 3 schema with one migration:

- `20261114160000_phase4_webhook_delete` adds `WEBHOOK_DELETE` to the `AntiNukeAction` enum.

Repository additions:

| Repository | Methods |
|---|---|
| `SecurityRepository` | Rule seeding/update, whitelist and bot approvals, punishment create/update/list, log channel get/set/list |
| `IncidentRepository` | `recordEventOnce`, `updateEvent`, `attachEvent`, `findOpenForActor`, `open`, `updateScore`, `getById`, recent events |

Additional guarantees:

- `recordEventOnce` deduplicates on the unique `(guildId, source, externalEventId)` key and returns `created: false` for duplicates.
- Incident opening is idempotent per actor and type while an incident is `OPEN` or `MONITORING`.
- Punishment creation is idempotent per `idempotencyKey`.
- Every write is tenant-scoped through `GuildServices`.
- Audit entries for rule seeding, enforcement approval/revocation, and punishment lifecycle are append-only.

---

## 9. Commands

### `/t77 antinuke`

| Subcommand | Access | Purpose |
|---|---|---|
| `status` | Owner or Manage Server | Mode, coverage, containment rules, trust counts, open incidents |
| `rule` | Owner or Manage Server | View/change enabled state, threshold, window, containment for one action |
| `approve` | **Owner only** | Approve `ENFORCE_REVERSIBLE` or `ENFORCE_DESTRUCTIVE` with explicit confirmation |
| `revoke` | **Owner only** | Immediately return to observation mode with a recorded reason |
| `trust-add` | Owner or Manage Server | Add a user or role whitelist entry, global or per-action |
| `trust-remove` | Owner or Manage Server | Revoke a trust entry |
| `trust-list` | Owner or Manage Server | List active trust entries |

`approve` requires `confirm: true` and the interaction to come from the recorded guild owner. Enforcement approval also requires the owner approval policy version.

### `/t77 logs`

| Subcommand | Access | Purpose |
|---|---|---|
| `set` | Owner or Manage Server | Route a category (`SECURITY`, `ANTI_NUKE`, `BOT`, …) to a text channel, announcement channel, or thread |
| `view` | Owner or Manage Server | Show configured routes |

The command verifies that the selected channel is resolvable, text-capable, and that T77 has `ViewChannel` and `SendMessages` before saving.

---

## 10. Alerts and log delivery

`SecurityAlertSink` builds T77-branded embeds for:

- threshold crossings with actor, action, count, severity, risk score, and containment decision;
- uncertain attribution, explicitly stating that no member was blamed;
- observation-mode "would have acted" decisions;
- failed containment with the dispatcher failure reason;
- incident severity updates.

Log destination precedence:

- `BOT_ADD`: `BOT` → `ANTI_NUKE` → `SECURITY`.
- All other actions: `ANTI_NUKE` → `SECURITY`.
- Final fallback: the guild's system channel.

Alert delivery is best-effort. A missing channel or failed send is logged and never blocks the security decision or the durable event write.

---

## 11. Tests

| Suite | Count | Coverage |
|---|---|---|
| `packages/security-core/test/anti-nuke/engine.test.ts` | 24 | Every monitored action, threshold boundaries, window edges, late events, risk/severity, disabled rules, every exemption, owner immunity, hierarchy, cooldown, observation mode, approval gates, uncertain attribution, multiple actors |
| `apps/bot/test/anti-nuke-coordinator.test.ts` | 8 | Duplicate delivery, trusted user, owner, uncertain attribution, approved destructive containment, observation mode, hierarchy block, approved bot |
| `apps/bot/test/anti-nuke-dispatcher.test.ts` | 10 | Alert no-op, idempotency, owner immunity, hierarchy, missing permission, kick/ban/role-removal safety, quarantine failure, rate limiting |
| `apps/bot/test/anti-nuke-normalizer.test.ts` | 34 | Every audit action mapping, permission/role/mass-role classification, bigint serialization, unsupported actions |
| `apps/bot/test/anti-nuke-resolver.test.ts` | 6 | Delayed audit log, bounded retries, wrong target, stale entry, transport failure, newest match |
| `packages/db/test/integration/phase4-security.test.ts` | 8 | Rule seeding, event dedupe, incident lifecycle, punishment idempotency, bot approval lifecycle, log routing, owner-only approval, tenant isolation |

Current totals:

- `packages/security-core`: 24 tests passing.
- `apps/bot`: 106 tests passing.
- `packages/db` unit: 23 passing.
- `packages/db` integration: 37 passing (including Phase 4).

The full `pnpm check` (typecheck, lint, unit tests, build) and `pnpm format:check` pass locally.

---

## 12. Known limitations

1. **Live Discord verification is pending.** No bot credentials or private test guild were available. Audit-log payloads, gateway fallbacks, real containment, and log delivery are covered by typed mocks, not a live server.
2. **Docker Compose was not executed.** Docker is not installed in this environment. The image and Compose file are syntax-checked only.
3. **Quarantine is not yet configurable.** The role selection lives in `AntiRaidConfig` and is wired in Phase 5. Until then, quarantine rules fail cleanly and are reported.
4. **In-memory counters do not survive a restart.** Durable events are preserved, but short-window counts reset. A restart during an active burst can undercount; Phase 5/10 can add Redis-backed windows.
5. **Audit-log attribution is still best-effort.** Delayed, missing, or executor-less entries produce `UNCERTAIN` events, and T77 will not punish on them.
6. **Discord hierarchy is absolute.** A compromised administrator above T77's role cannot be contained by the bot.
7. **Alert delivery depends on channel permissions.** Failed log delivery is reported, not retried indefinitely.
8. **Recovery is advisory.** T77 recommends safe actions; it does not restore deleted resources in Phase 4.

---

## 13. Acceptance status

| Criterion | Status |
|---|---|
| Observation mode detects and logs without changing the guild | Pass (engine + coordinator tests) |
| Threshold boundaries, windows, false positives | Pass |
| Delayed/missing audit logs handled safely | Pass |
| Trusted user/role and approved-bot exemptions | Pass |
| Owner immunity and role hierarchy | Pass |
| Multiple actors and response-loop prevention | Pass |
| Owner approval required before destructive enforcement | Pass |
| Incidents, events, punishments, and approvals persisted | Pass (integration) |
| Approved containment in a live private guild | **Not executed — no credentials/guild** |
| Docker Compose smoke | **Not executed — Docker unavailable** |

Phase 5 must not begin until the two environment-dependent items are verified in a private guild, or the owner explicitly accepts them as documented limitations.

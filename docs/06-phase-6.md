# T77 — Phase 6: AutoMod and Verification

**Status:** Implemented and validated against its automated acceptance criteria. Destructive enforcement remains disabled pending private-guild verification.
**Scope:** message-level spam and content policy, duplicate and flood detection, mention and caps checks, invite and domain filtering, configurable blocked words, per-channel/role/user/staff exemptions, warning and timeout policy, CAPTCHA and button verification, challenge expiry and retry limits, verification logs and incidents, and Anti-Raid quarantine release on a passing verification.

---

## 1. Design goals

Phase 6 adds message-level protection and a real verification lifecycle without weakening the Phase 4/5 safety model.

1. **Observation is the default.** AutoMod and verification start disabled. When AutoMod is enabled, observe mode records evidence and takes no Discord action.
2. **One message is not a punishment.** A timeout requires either prior warnings inside the policy window or a rule the owner explicitly marked high-confidence. The pure engine returns `SINGLE_MESSAGE_TIMEOUT_BLOCKED` otherwise.
3. **Exemptions run before detection.** Owner, whitelist, exempt channel, exempt role, exempt user, authorized staff, and configurable staff exemption are resolved before scoring. An exempt member produces no signal.
4. **Owner approval still gates enforcement.** AutoMod reuses the Phase 4 automation mode and recorded approval. Even a high-confidence rule cannot act without a non-observe mode and recorded owner approval.
5. **CAPTCHA is a deterrent, not proof of humanity.** Every prompt, log, and command states this explicitly. Verification is layered with raid detection, rate limits, and manual review.
6. **Only a hash is stored.** The plaintext CAPTCHA answer never leaves memory: the database stores a salted scrypt hash, and the engine verifies attempts against it.
7. **Expiry precedes answers.** A deadline check runs before any answer comparison, so an expired challenge can never pass.
8. **Quarantine escalation is bounded.** AutoMod may quarantine only while an Anti-Raid incident is open. It cannot widen containment beyond a raid the guild already approved.
9. **Verification releases quarantine, not stripped roles.** A passing challenge can remove the quarantine role; roles previously stripped by containment still require operator review.
10. **Degraded capability is reported.** If the Message Content intent is unavailable, AutoMod is skipped and `/t77 status` reports degraded capability instead of pretending to inspect text.

---

## 2. Architecture

```text
MessageCreate
      │
      ▼
AutomodCoordinator ──► AutomodWindowStore (Redis ZSET + Lua)
      │                        │
      │                        ├─ bounded message window (id, text, time)
      │                        └─ warning counter (Lua INCR + TTL)
      │
      ├─► exemption resolution (owner, whitelist, channel, role, user, staff)
      ├─► evaluateMessage (pure, weighted signals)
      ├─► SecurityEvent / AUTOMOD incident
      ├─► delete / warn / timeout / quarantine (dispatcher)
      └─► alert + Pub/Sub

GuildMemberAdd (human)
      │
      ▼
VerificationCoordinator ──► VerificationRepository (PostgreSQL)
      │                        │
      │                        ├─ config
      │                        ├─ challenge lifecycle
      │                        └─ audit entries
      ├─► CAPTCHA generation (PNG, local 5x7 bitmap font + zlib)
      ├─► salted scrypt hash (only the hash is persisted)
      ├─► button / modal interactions
      ├─► role swap (verified / unverified)
      ├─► quarantine release (optional, on pass)
      └─► alerts + Pub/Sub
```

### Pure core additions: `packages/security-core`

| File | Responsibility |
|---|---|
| `src/automod/types.ts` | Rules, policy, decision, block reasons, observation-safe defaults |
| `src/automod/engine.ts` | `evaluateMessage`: flood, duplicate, mention, caps, invite, blocked link, blocked word, `@everyone`, and the response gate |
| `src/verification/captcha.ts` | `generateCaptcha`, `renderCaptchaPng`, `hashAnswer`, `verifyAnswer`, `normalizeAnswer` |
| `src/verification/engine.ts` | `evaluateVerificationAttempt`, expiry-first checks, attempt accounting, policy defaults |

### DB additions: `packages/db`

| File | Responsibility |
|---|---|
| `src/repositories/automod-repository.ts` | Strict, dashboard-ready AutoMod policy schema, persistence, audit snapshots |
| `src/repositories/verification-repository.ts` | Verification config, challenge lifecycle, expiry queries, audit entries |
| `src/realtime/automod-window.ts` | Bounded Redis message window and atomic warning counter |
| `src/realtime/keys.ts` | `automod:window` and `automod:warnings` key families |
| `src/services/guild-services.ts` | Exposes `automod` and `verification` repositories |

### Bot additions: `apps/bot`

| File | Responsibility |
|---|---|
| `src/security/automod/coordinator.ts` | Discord message adapter, exemption resolution, incident coalescing, response dispatch |
| `src/security/automod/prisma-ports.ts` | Tenant-scoped AutoMod persistence adapters and stored-policy mapping |
| `src/security/automod/alerts.ts` | Branded AutoMod alerts that omit message text |
| `src/security/verification/coordinator.ts` | Challenge issuance, submission, expiry sweep, role swap, quarantine release |
| `src/security/verification/prisma-ports.ts` | Tenant-scoped verification persistence adapters |
| `src/security/verification/presenter.ts` | Panel, prompt, CAPTCHA embed, and modal components |
| `src/security/verification/handlers.ts` | Button and modal interaction handlers |
| `src/events/automod.ts` | `MessageCreate` intake with degraded-capability skip |
| `src/events/verification.ts` | `GuildMemberAdd` challenge issuance in the configured channel |
| `src/bootstrap/client.ts` | `MESSAGE_CONTENT_ENABLED` support and `automodCapability` reporting |
| `src/bootstrap/application.ts` | Wiring, verification button/modal registration, expiry sweeper, status reporting |

---

## 3. AutoMod detection

### Signals

| Signal | Weight | Meaning |
|---|---:|---|
| `FLOOD` | 40 | messages inside `floodWindowSeconds` meet `floodMessages` |
| `DUPLICATE` | 30 | normalised identical messages meet `duplicateThreshold` |
| `MENTION_SPAM` | 40 | mentions in one message meet `mentionLimit` |
| `EXCESSIVE_CAPS` | 15 | uppercase percentage meets `capsPercentage` above `capsMinimumLength` |
| `INVITE_LINK` | 45 | Discord invite link detected |
| `BLOCKED_LINK` | 45 | link host matches `blockedDomains` (subdomains included) |
| `BLOCKED_WORD` | 50 | configured word or phrase with letter/number boundaries |
| `EVERYONE_MENTION` | 35 | `@everyone` or `@here` mention |

The score is capped at 100. Duplicate comparison normalises Unicode, case, punctuation, and whitespace so trivial formatting differences do not create false positives. Short messages never trigger the caps rule.

### Default policy

| Setting | Default | Rationale |
|---|---|---|
| `enabled` | `false` | module starts disabled |
| `floodMessages` / `floodWindowSeconds` | `8` / `10` | requires a real burst |
| `duplicateThreshold` / `duplicateWindowSeconds` | `3` / `60` | repetition, not a repeated word |
| `mentionLimit` | `6` | one message cannot mass-ping |
| `capsPercentage` / `capsMinimumLength` | `70` / `20` | ignores short emphasis |
| `inviteLinksBlocked` | `true` | invite filtering is the common baseline |
| `linkFilterEnabled` | `true` | domain list is empty by default |
| `blockedDomains`, `bannedWords` | `[]` | no content policy is guessed |
| `exemptChannelIds`, `exemptRoleIds`, `exemptUserIds` | `[]` | explicit only |
| `ignoreStaff` | `true` | moderation staff are not auto-punished |
| `warnEnabled` | `true` | warnings are the preferred response |
| `timeoutEnabled` | `true` | timeout requires warning history or high confidence |
| `timeoutAfterWarnings` | `3` | three recorded warnings |
| `deleteOffendingMessage` | `true` | applies only when enforcement is permitted |
| `highConfidenceRules` | `[]` | first-message timeouts are impossible by default |
| `timeoutSeconds` | `600` | ten-minute timeout |

### Response gate

A response is blocked when any of the following holds:

- AutoMod or the policy is disabled (`AUTOMOD_DISABLED`);
- the author is a bot (`BOT_AUTHOR`);
- the author is the owner, whitelisted, exempt by channel/role/user, or exempt staff (`OWNER`, `WHITELISTED`, `EXEMPT_CHANNEL`, `EXEMPT_ROLE`, `EXEMPT_USER`, `STAFF`);
- no rule matched (`NO_MATCH`);
- a first-message timeout was recommended without a matching high-confidence rule (`SINGLE_MESSAGE_TIMEOUT_BLOCKED`);
- the guild is observing (`OBSERVE_MODE`);
- owner approval is missing (`OWNER_APPROVAL_REQUIRED`);
- no response is configured (`NO_ACTION_CONFIGURED`).

A blocked decision still records its signals, score, and reason. The pure engine never applies Discord actions; only the coordinator does, and only when `effectiveAction` is non-`NONE`.

### Message window and warning counter

The Redis window stores only the message ID, normalised comparison text, and timestamp. It is pruned on every write, bounded to 100 retained messages per member, and TTL-bound to the largest configured window plus a buffer. The warning counter uses an atomic Lua `INCR` + `PEXPIRE`, so concurrent shards cannot lose warnings. Warning state is cleared after a timeout or quarantine.

### Quarantine escalation

AutoMod may escalate a timeout-eligible decision to quarantine only when:

- the guild's Anti-Raid quarantine is enabled and a quarantine role is configured;
- an Anti-Raid `RAID` incident is open within the reuse window;
- the response gate already produced an effective timeout.

Otherwise it falls back to a normal timeout. This prevents AutoMod from expanding containment during a quiet period.

---

## 4. Verification

### Challenge lifecycle

1. A member joins, uses `/t77 verify start`, or presses the verification panel button.
2. If verification is disabled or misconfigured, no challenge is created.
3. A challenge is created with a salted scrypt hash, `maxAttempts`, and an expiry.
4. Any previous `PENDING` challenge for the same member is marked `INVALIDATED` so only the newest code can pass.
5. The challenge is posted in the configured guild channel; it is never DM-only.
6. A wrong answer increments attempts and stores the reason. A terminal wrong answer marks `FAILED` and opens a `VERIFICATION_ABUSE` incident.
7. An expired challenge is marked `EXPIRED` by the submission check or the five-minute sweeper.
8. A passing challenge marks `PASSED`, swaps the verified/unverified roles, and optionally releases an active quarantine.
9. Every terminal transition writes an append-only audit entry and a security event.

### CAPTCHA

- Generated locally as a PNG with a 5x7 bitmap font and Node `zlib`; no external image service or font dependency.
- Default length 6, alphabet excludes visually ambiguous `0/O` and `1/I`.
- Noise and distortion are configurable; the answer is normalised (case and whitespace insensitive).
- The stored value is a salted scrypt hash with a per-challenge salt.
- CAPTCHA is never described as proof of humanity.

### Button verification

The default mode is `BUTTON`, a presence confirmation with a limited lifetime and attempt tracking. `buttonFallbackEnabled` is a configuration field for environments that need both controls. A button submission cannot satisfy a CAPTCHA challenge, and a CAPTCHA modal cannot satisfy a button challenge.

### Configuration

| Setting | Default |
|---|---|
| `enabled` | `false` |
| `mode` | `BUTTON` |
| `buttonFallbackEnabled` | `false` |
| `challengeLength` | `6` |
| `timeoutSeconds` | `300` |
| `maxAttempts` | `3` |
| `captchaNoise` | `3` |
| `releaseQuarantineOnPass` | `true` |
| `verifiedRoleId` / `unverifiedRoleId` | unset |
| `channelId` | unset |

A challenge cannot be issued until a verified role or a verification channel is configured. Verification is still usable without a verified role, but the command reports that no role will be granted.

---

## 5. Persistence

Migration: `20261114224000_phase6_automod_verification`.

Schema additions:

- `AutomodConfig`: duplicate threshold, warning/timeout policy, high-confidence rules, per-user exemptions, message deletion, and link filter flags.
- `VerificationConfig`: button fallback, CAPTCHA noise, quarantine release on pass.
- `VerificationChallenge`: channel and message references, last attempt, failure reason.

Repository additions:

| Repository | Methods |
|---|---|
| `AutomodRepository` | `getOrCreate`, `update` with strict validation and audit snapshots |
| `VerificationRepository` | `getOrCreate`, `update`, `createChallenge`, `attachMessage`, `recordFailedAttempt`, `markPassed`, `markExpired`, `invalidate`, `findPendingForUser`, `findById`, `listExpired`, `listRecent`, `countByStatus` |

Every query is tenant-scoped through `TenantContext`; cross-guild challenge reads return nothing. Config updates reject empty patches, unknown fields, out-of-range values, invalid snowflakes, and unknown AutoMod rule names.

---

## 6. Commands

### `/t77 automod`

| Subcommand | Access | Purpose |
|---|---|---|
| `status` | Everyone in a server | Policy, filters, exemptions, response mode, and open AutoMod incidents |
| `configure` | Security operator | View or change thresholds, filters, warnings/timeouts, deletion, and high-confidence rule |
| `words-add` / `words-remove` / `words-list` | Security operator | Manage blocked words and phrases |
| `domains-add` / `domains-remove` / `domains-list` | Security operator | Manage blocked domains |
| `exempt-add` / `exempt-remove` / `exempt-list` | Security operator | Manage channel, role, and user exemptions |
| `test` | Security operator | Dry-run a message against the current policy with no action |

### `/t77 verify`

| Subcommand | Access | Purpose |
|---|---|---|
| `status` | Everyone in a server | Configuration, role/channel bindings, and challenge counts |
| `start` | Everyone in a server | Start verification for yourself |
| `configure` | Security operator | View or change mode, roles, channel, limits, and quarantine release |
| `panel` | Security operator | Post a public verification panel in a text channel |
| `sweep` | Security operator | Expire overdue challenges immediately |

Verification panels and prompts are real components under the `t77:` namespace. There are no dead buttons: the start button issues a challenge, the answer button opens a modal, and the confirm button submits a button challenge.

---

## 7. Alerts and publication

- AutoMod alerts route through `SECURITY` → `ANTI_RAID` → `MODERATION` log channels and never include the message text.
- Verification logs route through the `VERIFICATION` category and include outcome, attempt count, role result, quarantine result, and incident reference — never the CAPTCHA answer.
- Pub/Sub events: `security.automod.matched`, `verification.passed`, `verification.expired`.
- Delivery is best-effort; a missing or failed channel never blocks the durable event, incident, challenge transition, or role update.

---

## 8. Degraded operation

AutoMod requires the privileged **Message Content** intent. T77 reads `MESSAGE_CONTENT_ENABLED` (default `true`). When set to `false`:

- the Message Content intent is not requested at login;
- `MessageCreate` returns before evaluation;
- startup logs a warning;
- `/t77 status` reports **Degraded** with the reason.

T77 never silently scans empty content and reports a clean result. Anti-Nuke, Anti-Raid, Beast Mode, and verification remain operational without message content because they use audit logs, joins, and interactions.

---

## 9. Tests

| Suite | Coverage |
|---|---|
| `packages/security-core/test/automod/engine.test.ts` | Signal detection, normalisation, exemptions, observe mode, first-message block, high-confidence rules, false-positive cases |
| `packages/security-core/test/verification/engine.test.ts` | CAPTCHA rendering/hashing, expiry-first evaluation, attempt limits, button/CAPTCHA mode separation |
| `apps/bot/test/automod-coordinator.test.ts` | 17 cases: clean messages, observe mode, alerts, owner/channel/whitelist/staff exemptions, warn, timeout, single-message block, high confidence, owner approval gate, raid-bounded quarantine, window recording, text-free publication, disabled policy |
| `apps/bot/test/verification-coordinator.test.ts` | 14 cases: disabled/misconfigured, CAPTCHA issuance, already verified, wrong owner, wrong mode, expiry, retries, terminal failure incident, pass, role swap, quarantine release, disabled release, role errors, sweep |
| `packages/db/test/integration/phase6-security.test.ts` | Defaults, validated updates, audit entries, tenant isolation, challenge supersession, failure/pass transitions, expiry queries |
| `packages/db/test/integration/phase6-realtime.test.ts` | Bounded window, cutoff reads, guild/member isolation, warning counter, per-member clear |

Current automated totals:

- `packages/security-core`: 92 tests passing.
- `apps/bot`: 152 tests passing.
- `packages/db` unit: 23 tests passing.
- `packages/db` integration: 65 tests passing, including all Phase 3–6 suites.

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

The integration runner applied all five migrations to a clean database and passed against portable PostgreSQL 16.12 and Redis 5.0.14.

---

## 10. Known limitations

1. **Live Discord verification is still pending.** No bot credentials or private test guild are available. Gateway message intake, real role assignment, modal submission, quarantine release, and log delivery are covered by typed mocks and database/Redis integration tests, not a live server.
2. **CAPTCHA is not proof of humanity.** It deters simple automation only; determined humans or CAPTCHA-solving services can pass it. T77 does not claim complete protection.
3. **Message Content is privileged.** Without it, all content-based AutoMod rules are unavailable and reported as degraded.
4. **AutoMod is heuristic.** Coordinated spam can evade thresholds, and benign formatting can approach them. Defaults require multiple signals or warning history, and `/t77 automod test` exists for tuning.
5. **Quarantine escalation requires an open Anti-Raid incident.** AutoMod cannot quarantine during a quiet period by design.
6. **Verification does not restore stripped roles.** Only the quarantine role is removed on pass.
7. **Docker Compose remains unexecuted.** Docker is not installed in this environment. The image and Compose file are syntax-checked only.
8. **Phase 5 live drills remain unexecuted** and temporarily accepted as documented limitations: private raid drill, quarantine/manual release drill, Beast activation/expiry drill, and Compose smoke test.
9. **No dashboard controls yet.** Phase 6 exposes dashboard-ready schemas, but the React dashboard arrives in Phase 9.
10. **No verification rate limiter beyond challenge limits.** A member can restart a challenge; the newest challenge invalidates the previous one, but a cross-account abuse limiter is future work.

---

## 11. Acceptance status

| Criterion | Status |
|---|---|
| Advanced anti-spam detection | Pass (unit + coordinator + Redis) |
| Duplicate and repetitive message detection | Pass |
| Mention spam detection | Pass |
| Excessive caps detection | Pass |
| Link and Discord invite filtering | Pass |
| Configurable blocked words and domains | Pass (validated persistence) |
| Per-channel, per-role, and per-user exemptions | Pass |
| Configurable warning and timeout policies | Pass |
| CAPTCHA verification | Pass (local image + scrypt hash) |
| Optional button verification | Pass |
| Challenge expiration and retry limits | Pass |
| Verification logs and incident tracking | Pass (mocked Discord delivery) |
| Anti-Raid quarantine integration | Pass (release on verified pass; escalation bounded to an open raid) |
| Dashboard-ready configuration schemas | Pass (strict zod schemas and defaults) |
| Observation-only default | Pass |
| No automatic punishment from one message unless explicitly configured | Pass |
| False-positive and exemption test coverage | Pass |
| Message Content intent handled honestly | Pass (degraded status) |
| Live private-guild verification and role drill | **Not executed — no credentials/guild** |
| Docker Compose smoke | **Not executed — Docker unavailable** |

Phase 7 must not begin until Phase 6 acceptance is explicitly approved by the owner and the remaining live drills are either executed or accepted as documented limitations.

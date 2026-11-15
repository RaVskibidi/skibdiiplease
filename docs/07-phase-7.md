# T77 - Phase 7: Moderation and Whitelist

**Status:** Implemented and validated locally. Live Discord hierarchy/API drills remain outstanding and are listed at the end.

---

## 1. Scope delivered

- Ban, kick, timeout, warn, unban, and bulk message purge.
- Gap-free per-guild moderation case numbers, case detail, case listing with filters, and case closure/reversal.
- Warning history with active/total counts, revocation, and advisory escalation hints.
- T77 staff permission catalogue and custom user/role grants with optional expiry.
- Advanced whitelist management for users, roles, and channels, including per-action scope and temporary entries.
- Moderation audit trail, security-event recording, and configurable moderation log channel.
- Shared trust and grant evaluation across Anti-Nuke, Anti-Raid, AutoMod, and verification-facing security components.

Destructive automated enforcement remains disabled unless the existing Phase 4/5 approval flow is used. These commands are manual operator actions and are always subject to Discord hierarchy.

---

## 2. Permission model

T77 grants never replace Discord permissions and never bypass role hierarchy. They only widen what a member may ask T77 to do after the hierarchy gate passes.

Catalogue (`@t77/security-core`):

| Key | Purpose |
| --- | --- |
| `moderation.view` | View cases and warning history |
| `moderation.warn` | Issue and revoke warnings |
| `moderation.timeout` | Timeout members |
| `moderation.kick` | Kick members |
| `moderation.ban` | Ban members |
| `moderation.unban` | Remove bans |
| `moderation.purge` | Bulk delete messages |
| `whitelist.manage` | Manage whitelist entries |
| `staff.manage` | Manage T77 grants |
| `security.config` | Change security configuration |
| `security.exempt` | Exempt a user/role from Anti-Nuke, Anti-Raid, and AutoMod enforcement |
| `beast.override` | Activate or calm Beast Mode |
| `backup.manage` | Create and delete backups |
| `backup.restore` | Preview and run restores |

Grants are stored in `AccessGrant` with `subjectType` (`USER` or `ROLE`), `permissionKeys`, `grantedBy`, and optional `expiresAt`. Revocation is soft and audited.

### Authorization order

Every manual moderation action passes `authorizeModeration` in this order:

1. Refuse self-target.
2. Refuse the guild owner as a target.
3. Refuse bot targets for destructive actions (warn and unban still allow bots).
4. Require the actor's highest role to be strictly above the target's.
5. Require the T77 bot's highest role to be strictly above the target's.
6. Require the relevant Discord permission **or** an explicit T77 grant.
7. Require the T77 bot to hold the Discord permission needed for the API call.

The owner bypasses steps 4 and 6 but never step 5: T77 must still outrank the target.

---

## 3. Moderation cases

- `ModerationRepository.create` locks the guild row with `SELECT ... FOR UPDATE`, increments `caseSequence`, and inserts the case in one transaction, so concurrent moderators cannot collide.
- A case is written **before** the Discord API call so the Discord audit reason includes the case number.
- If Discord rejects a ban/kick/timeout/unban, the case is closed as `REVERSED` and the caller receives `DISCORD_ERROR`. A failed action is never reported as successful.
- Case types: `BAN`, `KICK`, `TIMEOUT`, `UNTIMEOUT`, `WARN`, `UNWARN`, `UNBAN`, `PURGE`, `LOCK`, `UNLOCK`, `SLOWMODE`, `SOFTBAN`.
- Statuses: `OPEN`, `CLOSED`, `REVERSED`.
- Every create/close writes an `AuditEntry`; moderation actions also write a `SecurityEvent` with source `COMMAND`.

### Warnings

- `services.moderation.warn` creates the `WARN` case, the linked active `Warning`, and the audit entry in one transaction.
- `revokeWarning` deactivates the warning, records `revokedAt`/`revokedBy`, creates an `UNWARN` case, and audits the reversal.
- `warningSummary` returns active and total counts.
- Escalation (`3` timeouts, `5` kicks, `7` bans by default) is **advisory only**. T77 never punishes automatically from a warning count.

---

## 4. Commands

### `/t77 mod`

| Subcommand | Notes |
| --- | --- |
| `ban user reason [delete-messages]` | Optional deletion window (0/1h/6h/24h) |
| `kick user reason` | |
| `timeout user duration reason` | `60s` to `28d`, accepts `10m`, `12h`, `7d` |
| `warn user reason` | Shows active count and advisory escalation |
| `warnings user` | Active/total counts and recent history |
| `warn-remove warning-id reason` | Creates an `UNWARN` case |
| `unban user reason` | Requires an existing ban |
| `case number` | Case detail |
| `cases [user] [type] [status] [limit]` | Filtered case list |
| `purge amount reason confirm` | Requires explicit confirmation |

### `/t77 whitelist`

- `add type target reason [duration] [scope] [action]`
- `remove entry [reason]`
- `list`

Durations accept `30m`, `12h`, `7d`, or `2w`. Expired entries are excluded from active lookups but retained for audit history.

### `/t77 staff`

- `grant type target permissions [duration]`
- `revoke grant`
- `list`

Only the owner or a member with Manage Server may grant or revoke. Only the owner may grant `staff.manage`. Keys are comma-separated, validated against the catalogue, and unknown keys are rejected.

---

## 5. Integration with security engines

- Manual moderation writes `SecurityEvent` rows that appear alongside anti-nuke/anti-raid/automod events.
- Whitelist and grant records are shared: active, unexpired entries are honoured by the anti-nuke resolver and anti-raid coordinator; auto-moderation requires an explicit security exemption key.
- `security.exempt` is the current catalogue key for exempting a user or role from automated engines. Legacy keys (`antinuke.exempt`, `antiraid.exempt`, `security.manage`, `security.admin`, `security.emergency`) remain accepted for compatibility.
- Verification, Anti-Raid, AutoMod, and Anti-Nuke continue to act only through the hierarchy-aware, idempotent punishment dispatcher.

---

## 6. Validation

- `@t77/security-core`: 112 tests across 6 files, including 20 new moderation authorization/duration/permission tests.
- `@t77/bot`: 164 tests across 18 files, including 12 new coordinator tests covering success paths, self/owner/bot/hierarchy refusals, grant handling, missing members, and case reversal after Discord failure.
- `@t77/db` integration: 70 tests across 10 files, including new warning persistence/revocation, warning summaries, filtered case lists, temporary whitelist expiry, temporary staff grant expiry, and cross-tenant isolation.
- `@t77/security-core` and `@t77/bot` typecheck clean.

---

## 7. Known limitations and outstanding live tests

- No live Discord gateway/API test was run in this environment. The following require a private test guild and bot token:
  - Real ban/kick/timeout/unban execution and audit-log reason verification.
  - Discord role hierarchy ordering against the T77 bot role.
  - `ModerateMembers` timeout API behaviour at the 28-day boundary.
  - Moderation log channel delivery.
  - Bulk delete behaviour for messages older than 14 days.
- Case reversal is best-effort: if both the Discord call and the reversal write fail, the case remains `OPEN` and the error is logged.
- Warning escalation is advisory; there is no automatic warning-to-punishment policy.
- Temporary entries are enforced by query-time expiry checks. Expired rows are retained (not deleted) for audit integrity.
- Live multi-tenant stress testing beyond the integration suite is outstanding.

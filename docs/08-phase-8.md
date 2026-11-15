# T77 - Phase 8: Backup and Recovery

**Status:** Implemented and validated locally. Live Discord backup/restore drills and live S3-compatible storage tests remain outstanding and are listed at the end.

---

## 1. Scope delivered

- Manual, scheduled, and pre-restore backups of guild configuration exposed by the Discord API.
- Role, channel, permission-overwrite, emoji, sticker, and guild-settings snapshots.
- Compressed snapshot payloads in local or S3-compatible object storage; PostgreSQL stores metadata only.
- Backup history, checksum verification, retention dates, soft deletion, and audit entries for every transition.
- Selective restore previews (roles, channels, permissions, emojis, stickers, guild settings, optional deletion of missing resources).
- Confirmation-token gated restore execution with mandatory pre-restore backup and per-item error reporting.
- Restore job transaction tracking (`PENDING` -> `PREVIEWED` -> `RUNNING` -> `COMPLETED`/`FAILED`/`CANCELLED`).
- `apps/worker` scheduling process that requests due backups and retention sweeps over Redis Pub/Sub.
- Bot-side request listener that performs Discord capture and object deletion, preserving the token/storage boundary.

Destructive automated enforcement remains disabled. Nothing in Phase 8 changes enforcement policy.

---

## 2. What is and is not recoverable

Captured:

| Resource | Fields |
| --- | --- |
| Roles | Name, colour, hoist, mentionable, permission bitfield, position, icon/emoji |
| Channels | Name, type, position, parent, topic, NSFW, slowmode, bitrate, user limit |
| Permission overwrites | Target ID, type, allow bitfield, deny bitfield |
| Emojis | Name, animated flag, source URL |
| Stickers | Name, description, tags, format, source URL |
| Guild settings | Name, verification level, notification default, explicit-content filter |

Never captured and never claimed to be recoverable:

- Messages, attachments, and thread history.
- Members, join history, and member roles.
- Bans, invites, audit logs, scheduled events, and integrations.
- Webhook URLs/tokens and application commands.
- OAuth connections.
- Original IDs of deleted roles and channels: T77 recreates resources, but Discord assigns new IDs.
- Emoji/sticker images when their source URLs have expired.

`UNSUPPORTED_SNAPSHOT_DATA` in `packages/security-core/src/backup/types.ts` is included in every preview so operators see the limits before restoring.

---

## 3. Storage model

- Snapshot bytes are gzip-compressed JSON and written to object storage under `guilds/<guildId>/backups/<backupId>.json.gz`.
- PostgreSQL stores `objectKey`, SHA-256 `checksum`, `sizeBytes`, `schemaVersion`, `retentionUntil`, and status.
- `BACKUP_STORAGE=local` uses `BACKUP_LOCAL_DIR` (default `./data/backups`) with path-traversal guards.
- `BACKUP_STORAGE=s3` uses SigV4-signed `PUT`, `GET`, `DELETE`, and `HEAD` calls against any S3-compatible endpoint (AWS S3, MinIO, R2, B2). `S3_FORCE_PATH_STYLE` defaults to `true`.
- Checksums are verified on every read. A corrupted object is refused before any restore is planned.
- Retention uses soft deletion: metadata is marked `DELETED`, the stored object is removed, and audit history is retained.

---

## 4. Scheduling and the worker

`apps/worker` is a control plane:

1. Reads enabled guild schedules from `GuildConfig`.
2. Claims due slots by writing `lastScheduledBackupAt` before publishing.
3. Publishes `scheduled-backup` or `retention-sweep` messages on `<prefix>:backup:requests`.
4. Never talks to Discord and never holds storage credentials.

The bot subscribes to the request channel and:

- Fetches the guild, captures the snapshot, stores it, and marks the backup `READY`.
- For retention sweeps, iterates its current guilds and purges expired backups.
- Writes `lastScheduledBackupAt` again after a successful capture.

Schedule settings live in `GuildConfig`:

| Field | Default | Meaning |
| --- | --- | --- |
| `backupsEnabled` | `false` | Enables scheduled backups |
| `backupIntervalHours` | `24` | Hours between scheduled backups (1-720) |
| `backupRetentionDays` | `30` | Retention for new backups (1-3650) |
| `lastScheduledBackupAt` | `null` | Last request time; scheduler bookkeeping |

Worker environment:

```
WORKER_TICK_MS=60000
WORKER_RETENTION_SWEEP_MS=3600000
WORKER_RUN_ON_START=true
WORKER_HEALTH_ENABLED=true
WORKER_HEALTH_HOST=127.0.0.1
WORKER_HEALTH_PORT=3001
```

---

## 5. Restore safety sequence

1. `/t77 backup preview` computes a deterministic diff between the selected snapshot and the current guild.
2. A `RestoreJob` row is created and marked `PREVIEWED`.
3. `/t77 backup restore` requires `confirmation:RESTORE` and `confirm:true`.
4. The confirmation token is persisted on the job.
5. A mandatory `PRE_RESTORE` backup is captured. If it fails, nothing is changed.
6. Items are applied in dependency order: role/channel creation, updates, permission overwrites, guild settings, emoji/sticker recreation, then opt-in deletions.
7. Each item failure is recorded; the job completes with an error list rather than claiming full success.
8. Discord permission checks (`ManageRoles`, `ManageChannels`, `ManageGuild`, `ManageGuildExpressions`) are re-evaluated at execution time. Hierarchy is checked before deleting roles.

Deletion of missing roles/channels is never implied. It requires `deleteMissing: true` and is reported as `HIGH` risk in the preview.

---

## 6. Commands

`/t77 backup create` - capture a manual backup now.
`/t77 backup list` - recent backup metadata.
`/t77 backup delete backup confirm:true` - soft-delete metadata and remove the object.
`/t77 backup preview backup categories [role-ids] [channel-ids] [delete-missing]` - diff without changing anything.
`/t77 backup restore job confirmation:RESTORE confirm:true` - execute a previewed restore.
`/t77 backup status job` - progress, timestamps, and errors.
`/t77 backup retention days` - retention for new backups.
`/t77 backup schedule enabled [interval-hours]` - enable or disable scheduled backups.

Access requires the guild owner, `Manage Server`, or the relevant T77 grant (`backup.manage`, `backup.restore`). Grants never bypass Discord hierarchy or the bot's own permissions.

---

## 7. Validation

Executed locally:

- `@t77/security-core`: 124 tests across 7 files, including 12 snapshot validation, restore-preview, deletion opt-in, filtering, and unsupported-data tests.
- `@t77/bot`: 184 tests across 21 files, including new local-storage, S3 SigV4, and backup coordinator tests (capture, failure, retention, corrupted snapshot, pre-restore backup, confirmation gating, deletion, purge).
- `@t77/worker`: 6 tests covering due-slot claiming, publish failures, sweep throttling, and empty-guild behaviour.
- `@t77/db` unit: 28 tests across 5 files, including backup request protocol round-trips and rejection cases.
- `@t77/db` integration: 79 tests across 11 files against PostgreSQL 16 and Redis 7, including backup lifecycle, failed capture, retention/soft deletion, restore state machine, cross-tenant rejection and isolation, scheduled-backup due queries, disabled schedules, and bot-left exclusion.
- Migration `20261114230000_phase8_backup_retention` applied from an empty database.
- `@t77/bot`, `@t77/db`, `@t77/security-core`, and `@t77/worker` typecheck clean. Worker production build succeeds.

Not executed (documented, not claimed as passed):

- Live Discord snapshot capture and selective restore in a real guild.
- Discord hierarchy and permission behaviour during role/channel deletion.
- Live S3-compatible storage against MinIO, R2, B2, or AWS S3 (only SigV4 construction and failure handling were tested with fakes).
- Multi-replica worker contention beyond the claim-before-publish database update.
- Restore of an emoji/sticker whose source URL has expired (implementation reports the failure; no live asset test was run).

---

## 8. Known limitations

- Discord must be able to recreate a resource; T77 never fabricates an image or a deleted resource.
- Role position restoration is best-effort because Discord enforces the bot's highest role.
- Channel type changes are not possible through the Discord API; the preview reports them but creation/update may fail and is recorded as an item error.
- If the bot loses its connection mid-restore, the job may remain `RUNNING`; operators can inspect it with `/t77 backup status` and re-run the restore.
- `RestoreJob` rows do not expire automatically. Retention currently applies to backup objects only.
- The worker schedules one retention sweep per configured interval for all guilds; it does not shard sweeps across replicas.

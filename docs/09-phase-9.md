# T77 - Phase 9: Security Dashboard

**Status:** Implemented and validated locally. Typecheck, lint, unit tests, production builds, and database integration tests pass. Live Discord OAuth against a production application and browser end-to-end tests remain outstanding and are listed at the end.

---

## 1. Scope delivered

- `apps/api`: an Express 5 REST API with Discord OAuth2 (Authorization Code + PKCE), server-side sessions, CSRF protection, guild authorization, and Server-Sent Events.
- `apps/web`: a React 19 + TypeScript + Tailwind 4 dashboard with original T77 dark black/gray/red branding and all 15 sections from `docs/01-architecture.md`.
- A typed dashboard action queue in PostgreSQL. The API never talks to Discord for mutating work; the bot claims queued rows, performs the Discord call with its own token, and records the outcome.
- Guild overview, security status, module configuration, backups, moderation history, audit logs, staff grants, bot protection, and settings are all wired to real endpoints.
- Live updates over SSE, optimistic-concurrency configuration saves, confirmation dialogs, and explicit empty/error/loading states.

---

## 2. Authentication and sessions

Flow:

1. `GET /api/auth/discord` creates a random `state` and PKCE code verifier, signs them into a short-lived OAuth cookie, and redirects to Discord.
2. Discord returns to `GET /api/auth/discord/callback`. The API verifies the signed cookie, compares `state`, and exchanges the code with the verifier.
3. The access and refresh tokens are encrypted with AES-256-GCM using `ENCRYPTION_KEY` and stored in `oauth_credentials`. There are no plaintext token columns.
4. A random opaque session token is stored in an `HttpOnly`, `SameSite=Lax` cookie. Only its SHA-256 hash is stored in `dashboard_sessions`.
5. The session carries a CSRF token. Mutating requests must send it in `x-csrf-token` and it must hash to the session record.
6. Guild access is revalidated against Discord at most once per 60 seconds per identity, with the result cached in Redis. If Discord is unreachable, the last known manageable guild IDs are used.

Security properties:

- OAuth cookies are signed and expire after 10 minutes.
- Sessions expire (`SESSION_TTL_SECONDS`, default 12 hours) and can be revoked.
- Cookies use `Secure` when `COOKIE_SECURE=true`; shutdown does not log tokens.
- The API rejects cross-origin mutations, malformed guild snowflakes, unmanageable guilds, and guilds where T77 is no longer installed.
- Permissions enforced by T77 grants are checked server-side for **user** grants. Role-based T77 grants are applied by the bot, which can resolve member roles; the API cannot evaluate them without a member role cache. This is documented rather than hidden.

---

## 3. API surface

Base path `/api`. All guild routes require a session, guild access, and CSRF on writes.

Auth:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/auth/discord` | Start OAuth |
| GET | `/auth/discord/callback` | Complete OAuth |
| GET | `/auth/session` | Current user, guilds, CSRF token |
| POST | `/auth/logout` | Revoke session |

Guild:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/guilds` | Manageable guilds with bot presence |
| GET | `/guilds/:id/overview` | Security score, modules, incidents, cases, events, queued actions |
| GET/PATCH | `/guilds/:id/config` | Versioned configuration |
| POST | `/guilds/:id/config/reset` | Reset to defaults |
| POST | `/guilds/:id/config/approval` | Record owner enforcement approval |
| POST | `/guilds/:id/config/revoke-enforcement` | Revoke enforcement |
| GET | `/guilds/:id/settings` | Configuration plus log routes |
| GET | `/guilds/:id/security` | Security status and recent incidents |
| GET | `/guilds/:id/audit-logs` | Cursor-paginated audit trail |
| GET/POST/DELETE | `/guilds/:id/staff` | T77 staff grants |
| GET/PATCH/POST/DELETE | `/guilds/:id/bot-protection` | Bot approval list |
| GET | `/guilds/:id/actions` | Queued dashboard actions |
| GET | `/guilds/:id/actions/:actionId` | Action status polling |
| POST | `/guilds/:id/actions/:actionId/cancel` | Cancel a pending action |

Modules:

| Method | Path |
| --- | --- |
| GET/PATCH | `/guilds/:id/anti-nuke` |
| POST | `/guilds/:id/anti-nuke/approval` |
| GET/PATCH | `/guilds/:id/anti-raid` |
| GET/PATCH | `/guilds/:id/beast-mode` |
| POST | `/guilds/:id/beast-mode/override` |
| GET/PATCH | `/guilds/:id/anti-spam` |
| GET/PATCH | `/guilds/:id/automod` |
| GET/PATCH | `/guilds/:id/verification` |
| GET/POST | `/guilds/:id/whitelist` |
| PATCH/DELETE | `/guilds/:id/whitelist/:entryId` |
| GET | `/guilds/:id/moderation/cases` |
| GET | `/guilds/:id/moderation/cases/:caseId` |
| GET | `/guilds/:id/moderation/warnings` |
| GET | `/guilds/:id/quarantine` |

Backups:

| Method | Path |
| --- | --- |
| GET/POST | `/guilds/:id/backups` |
| GET | `/guilds/:id/backups/jobs` |
| GET | `/guilds/:id/backups/:backupId` |
| POST | `/guilds/:id/backups/:backupId/preview` |
| POST | `/guilds/:id/backups/:backupId/restore` |
| DELETE | `/guilds/:id/backups/:backupId` |

Events:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/guilds/:id/events` | SSE stream for guild events |

All create/delete/preview/restore/override calls write a `DashboardAction` row and return immediately. The dashboard polls the action until the bot settles it.

---

## 4. Dashboard action protocol

Action types and payloads:

| Type | Payload |
| --- | --- |
| `backup.create` | optional `retentionDays` |
| `backup.delete` | `backupId` |
| `backup.preview` | `backupId`, `selection.categories` |
| `backup.restore` | `backupId`, `jobId`, `confirmationId` |
| `beast.override` | `action` (`activate`/`calm`), `reason` |

- Payloads are validated by Zod before the row is written and again before the bot executes it.
- Unknown types and extra fields are rejected.
- The bot claims rows with a compare-and-set update, so two bot processes cannot execute one action.
- Claimed rows always end `COMPLETED` or `FAILED`. If the bot restarts while an action is `RUNNING`, a startup sweep marks it `FAILED` with a restart explanation.
- Every request, completion, failure, and cancellation is audited.
- Destructive automation still requires recorded owner approval; queuing an action cannot bypass enforcement policy.

---

## 5. Dashboard sections

All 15 architecture sections are routed under `/servers/:guildId`:

1. Overview
2. Security Status
3. Anti-Nuke
4. Anti-Raid
5. Beast Mode
6. Anti-Spam
7. AutoMod
8. Verification
9. Whitelist
10. Moderation
11. Bot Protection
12. Backups
13. Audit Logs
14. Staff
15. Settings

The root path is the login/server picker. A guild route refuses servers the user cannot manage, servers where T77 is not installed, and unknown servers.

UI behavior:

- Loading, empty, and error states are explicit.
- Buttons are wired to real requests; no decorative controls.
- Configuration forms save with `expectedVersion` and surface version conflicts.
- Enforcement approval and destructive actions use confirmation dialogs.
- Warnings, audit details, restore previews, and unsupported-data lists are displayed as returned by the API.
- The layout is responsive, with a collapsible navigation rail and horizontal scrolling tables.

---

## 6. Live events

`GET /api/guilds/:id/events` is a Server-Sent Events stream.

- The API subscribes to the guild's Pub/Sub channel and forwards typed events.
- `Last-Event-ID` triggers a `resync` event so the client reloads.
- The dashboard listens for configuration, incident, Beast, verification, backup, and action events and refreshes the affected page.
- The stream does not carry Discord tokens or secrets.

---

## 7. Configuration

New API environment variables:

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `API_HOST` | no | `127.0.0.1` | Bind address |
| `API_PORT` | no | `4000` | Port |
| `API_PUBLIC_URL` | no | `http://127.0.0.1:4000` | Public origin |
| `WEB_ORIGIN` | no | `http://127.0.0.1:5173` | Allowed browser origin |
| `TRUST_PROXY` | no | `false` | Enable when behind a reverse proxy |
| `DISCORD_CLIENT_ID` | yes | - | OAuth application ID |
| `DISCORD_CLIENT_SECRET` | yes | - | OAuth client secret |
| `DISCORD_REDIRECT_URI` | yes | - | Must match the Discord portal exactly |
| `SESSION_SECRET` | yes | - | At least 32 characters; signs OAuth cookies |
| `ENCRYPTION_KEY` | yes | - | Exactly 32 base64 bytes; encrypts OAuth tokens |
| `SESSION_TTL_SECONDS` | no | `43200` | Session lifetime |
| `COOKIE_SECURE` | no | `false` | Set `true` behind HTTPS |
| `COOKIE_DOMAIN` | no | - | Optional cookie domain |
| `CACHE_TTL_SECONDS` | no | `300` | Redis cache TTL |

Web build variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `VITE_API_URL` | `/api` | API base; the dev server proxies `/api` to the API |

---

## 8. Process model

```text
Browser -> apps/web (static build)
        -> apps/api (OAuth, sessions, REST, SSE)
        -> PostgreSQL (configuration, audit, sessions, action queue)
        -> Redis (cache, Pub/Sub, OAuth guild cache)
apps/bot -> Discord gateway + REST, claims dashboard actions, performs captures/restores
apps/worker -> scheduled backup scheduling and retention requests
```

The API does not hold a Discord bot token and never performs guild mutations directly. The bot does not serve HTTP to browsers. This keeps token and storage boundaries intact.

---

## 9. Validation performed

| Check | Result |
| --- | --- |
| Workspace typecheck | Pass |
| Workspace lint | Pass |
| Workspace format check | Pass |
| Unit tests | shared 9, security-core 124, db 37, api 45, bot 194, worker 6, web 4 |
| Production builds | web, api, bot, worker |
| Database integration | 85 tests across 12 files, including Phase 9 dashboard/whitelist isolation |
| Empty-database migrations | All 8 migrations apply from scratch |
| Redis-dependent integration | Passed against the test Redis database |

Phase 9 tests cover OAuth transaction signing/expiry, PKCE, token cipher round-trips and tamper rejection, environment validation, Discord adapter behavior, session lifecycle, guild access caching, CSRF/origin rejection, route authorization, dashboard action payload validation, action claim/settle/cancel/stale handling, and tenant isolation.

---

## 10. Known limitations and outstanding tests

- No live Discord OAuth login was executed against a production Discord application in this environment.
- No browser-based end-to-end test (Playwright) was run. The UI is typechecked and built, and its pure formatting helpers are unit tested.
- Role-based T77 grants are honored by the bot but not evaluated by the API.
- SSE delivery is validated by build and unit-level composition, not by a live multi-process Pub/Sub drill.
- Backup preview/restore from the dashboard require a live bot and real Discord guild; they were exercised through unit tests and the action protocol, not a live destructive drill.
- No dedicated dashboard API rate limiter is implemented. OAuth cookies are short-lived, sessions expire, request bodies are capped at 256 KB, and Discord applies OAuth token limits.
- The dashboard is read-only for moderation actions by design. Moderation execution stays in Discord so hierarchy checks always run against live member state.

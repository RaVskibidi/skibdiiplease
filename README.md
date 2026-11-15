# T77 SEC BOT - Website

The T77 dashboard: a React 19 + TypeScript + Tailwind 4 frontend and an Express 5 API with Discord OAuth2, server-side sessions, CSRF protection, PostgreSQL-backed configuration, and Server-Sent Events.

This folder is independently installable and runnable. It contains only the website applications plus the workspace packages they import.

## Contents

```text
Website/
├── apps/api/            Express API, OAuth2, sessions, routes, SSE
├── apps/web/            React dashboard (all 15 sections)
├── packages/db/         Prisma schema, migrations, repositories, services
├── packages/shared/     brand tokens, formatting, errors
├── packages/security-core/ pure policy and permission engines
├── docs/                architecture, phase reports, deployment guide
├── .env.example         API and web configuration template
└── package.json         workspace scripts
```

## Requirements

- Node.js 24+ (engine range `>=24 <27`)
- pnpm 10.34.9
- PostgreSQL 16
- Redis 7
- A Discord application with OAuth2 credentials and the T77 bot installed in at least one server

## Setup

```bash
cd "Website"
pnpm install
copy .env.example .env      # Windows
# cp .env.example .env      # macOS/Linux
```

Fill `.env`:

- `DATABASE_URL`, `REDIS_URL`
- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI` (must match the Discord portal exactly)
- `SESSION_SECRET` (32+ characters)
- `ENCRYPTION_KEY` (32 base64 bytes)
- `WEB_ORIGIN` and `API_PUBLIC_URL`
- `COOKIE_SECURE=true` when served over HTTPS

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Apply migrations (the database must already exist):

```bash
pnpm db:migrate
pnpm db:status
```

Run:

```bash
pnpm dev        # API + web together
pnpm dev:api    # API only, http://127.0.0.1:4000
pnpm dev:web    # web only, http://127.0.0.1:5173
```

Open <http://127.0.0.1:5173> and sign in with Discord. A server appears only if T77 is installed there and your Discord account can manage it.

## Production

```bash
pnpm build
pnpm start      # API
```

Serve `apps/web/dist` with any static host or reverse proxy and forward `/api/*` to the API. Keep SSE unbuffered (`proxy_buffering off` in nginx). See `docs/deployment.md` for a complete guide, environment table, and rollback checklist.

## Sections

Overview, Security Status, Anti-Nuke, Anti-Raid, Beast Mode, Anti-Spam, AutoMod, Verification, Whitelist, Moderation, Bot Protection, Backups, Audit Logs, Staff, and Settings.

Dashboard mutations are written to a PostgreSQL action queue. The T77 bot executes them, so the API never holds a bot token and never talks to Discord for writes. Moderation is read-only here by design.

## Checks

```bash
pnpm check          # typecheck, lint, unit tests, build
pnpm format:check
```

Database integration tests need disposable services:

```bash
# PowerShell
$env:TEST_DATABASE_URL='postgresql://t77@127.0.0.1:55432/t77_test?schema=public'
$env:TEST_REDIS_URL='redis://127.0.0.1:56379/15'
pnpm --filter @t77/db test:integration
```

Never point the integration runner at production: it drops the `public` schema and flushes the Redis database.

## Security

- OAuth tokens are AES-256-GCM ciphertext; no plaintext token columns exist.
- Session tokens are stored as SHA-256 hashes in `HttpOnly` cookies.
- Every mutating request requires a same-origin check and a session-bound CSRF token.
- Role-based T77 grants are applied by the bot, not the API; only user grants are evaluated server-side.
- No `.env` file or real secret is included. `node_modules`, build output, and the generated Prisma client are local artifacts recreated by `pnpm install` and `pnpm check`.

## Limitations

- Live Discord OAuth and browser end-to-end tests were not executed in the build environment.
- Backups, restores, and Beast overrides require the separate Bot deployment to be running.
- Docker was not executed.

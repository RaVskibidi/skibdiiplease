# T77 - Production Deployment Guide

This guide deploys T77 as four processes plus PostgreSQL and Redis. Read it fully before touching a live server. Destructive enforcement is off by default and must be approved separately.

---

## 1. Topology

```text
Internet
  |-- HTTPS reverse proxy
        |-- /            -> apps/web static build
        |-- /api/*       -> apps/api (127.0.0.1:4000)
        |-- /healthz     -> apps/api
apps/bot     -> Discord gateway + REST, action queue consumer
apps/worker  -> scheduled backup control plane
PostgreSQL   -> durable state
Redis        -> cache, Pub/Sub, rate/window state
Object store -> backup snapshot bytes (local volume or S3-compatible)
```

Only the reverse proxy is public. PostgreSQL, Redis, the API, and health endpoints bind to loopback or a private network.

---

## 2. Prerequisites

- Linux host with Docker, or Node.js 24 and pnpm 10.34.9.
- PostgreSQL 16 with a dedicated database and user.
- Redis 7 with persistence enabled.
- A Discord application with:
  - Bot token.
  - OAuth2 client ID and secret.
  - Redirect URI `https://<dashboard-host>/api/auth/discord/callback`.
  - Server Members and Message Content privileged intents enabled.
- TLS certificate for the dashboard host.
- Optional S3-compatible bucket for backups.

---

## 3. Secrets

Generate independent values:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"  # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"    # ENCRYPTION_KEY
```

Rules:

- `SESSION_SECRET` at least 32 characters.
- `ENCRYPTION_KEY` exactly 32 base64 bytes. Changing it makes existing OAuth credentials unreadable; users must sign in again.
- Bot token, client secret, database URL, Redis URL, S3 keys, session secret, and encryption key never go into the web build or source control.
- Store production secrets in your platform secret manager or an untracked `.env` with `chmod 600`.

Required environment (see `.env.example`, `apps/api/.env.example`, `apps/web/.env.example`):

| Process | Required |
| --- | --- |
| bot | `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DATABASE_URL`, `REDIS_URL` |
| api | `DATABASE_URL`, `REDIS_URL`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `WEB_ORIGIN`, `API_PUBLIC_URL` |
| worker | `DATABASE_URL`, `REDIS_URL` |
| web | build-time `VITE_API_URL` (default `/api`) |

Production API values:

```dotenv
NODE_ENV=production
API_HOST=127.0.0.1
API_PORT=4000
API_PUBLIC_URL=https://t77.example.com
WEB_ORIGIN=https://t77.example.com
TRUST_PROXY=true
COOKIE_SECURE=true
LOG_PRETTY=false
```

Set `REDIS_KEY_PREFIX` to a deployment-unique value if several T77 instances share Redis.

---

## 4. Database

Create the role and database:

```sql
CREATE ROLE t77 LOGIN PASSWORD '<strong-password>';
CREATE DATABASE t77 OWNER t77;
```

Apply migrations from the repository root with the production `DATABASE_URL`:

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:status
```

The migration chain is designed to apply from an empty database. Back up the database before every deployment:

```bash
pg_dump --format=custom --file=t77-$(date +%F).dump "$DATABASE_URL"
```

The audit trail is append-only; PostgreSQL triggers reject `UPDATE`, `DELETE`, and `TRUNCATE` on `audit_entries`, including from the application role. Do not attempt to "clean" audit history.

---

## 5. Build

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

Artifacts:

- `apps/web/dist` - static dashboard.
- `apps/api/dist/index.js` - API bundle.
- `apps/bot/dist/index.js` - bot bundle.
- `apps/worker/dist/index.js` - worker bundle.

`pnpm build` generates Prisma once and then builds each app serially to avoid concurrent Prisma generation races.

---

## 6. Process management

Run each as a separate service with restart-on-failure and its own environment.

Example systemd units (adjust paths and user):

```ini
# /etc/systemd/system/t77-bot.service
[Unit]
Description=T77 Discord bot
After=network-online.target postgresql.service redis.service
Wants=network-online.target

[Service]
Type=simple
User=t77
WorkingDirectory=/opt/t77
EnvironmentFile=/opt/t77/.env
ExecStart=/usr/bin/node apps/bot/dist/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Create equivalent units for `apps/api/dist/index.js` and `apps/worker/dist/index.js`. The API unit must have `COOKIE_SECURE=true` and bind loopback.

The bot exposes a loopback health service on port 3000 by default. Point your supervisor at `/readyz`; a `503` means the gateway, command registration, PostgreSQL, or Redis is not ready.

Shutdown is graceful within `SHUTDOWN_TIMEOUT_MS` (default 10 seconds). Use `KillSignal=SIGTERM`.

---

## 7. Reverse proxy

Example nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name t77.example.com;

    ssl_certificate     /etc/letsencrypt/live/t77.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/t77.example.com/privkey.pem;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    root /opt/t77/apps/web/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-Id $request_id;
        proxy_buffering off;          # required for SSE
        proxy_read_timeout 1h;
    }

    location / {
        try_files $uri /index.html;
    }
}
```

Set `TRUST_PROXY=true` when the API runs behind this proxy. `proxy_buffering off` matters for `/api/guilds/:id/events`.

If the dashboard is served from a different origin, set `WEB_ORIGIN` exactly and rebuild the web app with a matching `VITE_API_URL`; cross-origin cookies require HTTPS and correct cookie settings.

---

## 8. Docker Compose

`compose.yaml` starts PostgreSQL and Redis, and optionally the bot:

```bash
docker compose up -d postgres redis
docker compose --profile bot up -d --build
```

The bot image builds from `infra/docker/bot.Dockerfile`. It does not include the API, web server, or worker. Deploy those as separate services or extend the compose file.

Docker was not available in the validation environment. Treat the Docker path as unexecuted until you build it on your host; the local Node path is the validated one.

---

## 9. Object storage

Local backups:

```dotenv
BACKUP_STORAGE=local
BACKUP_LOCAL_DIR=/var/lib/t77/backups
```

The directory must be writable by the bot user, persistent, and included in host backups. Path traversal is rejected.

S3-compatible storage:

```dotenv
BACKUP_STORAGE=s3
S3_ENDPOINT=https://s3.example.com
S3_REGION=us-east-1
S3_BUCKET=t77-backups
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=true
```

Only the bot needs storage credentials. The API never holds them. Use a bucket policy limited to the configured prefix and enable server-side encryption and versioning.

---

## 10. Discord setup

1. Invite T77 with `bot` and `applications.commands`.
2. Enable Server Members and Message Content intents.
3. Place the T77 role above any role it must moderate.
4. Grant only the permissions T77 needs: Manage Roles, Manage Channels, Kick Members, Ban Members, Moderate Members, Manage Messages, View Audit Log, Manage Webhooks, Manage Expressions, Read Message History, Send Messages, Embed Links.
5. Add the production OAuth redirect URI in the Discord portal.
6. Start the bot, confirm `/t77 status` reports gateway and command readiness.
7. Configure log channels with `/t77 logs set`.
8. Keep automation in `OBSERVE` until the live drills below pass.

---

## 11. Rollout checklist

- [ ] Database migrated and `pnpm db:status` clean.
- [ ] `pnpm check` passes on the exact release commit.
- [ ] `pnpm build` produced all four artifacts.
- [ ] `.env` is untracked, mode 600, and contains no example values.
- [ ] Dashboard loads over HTTPS and Discord login succeeds.
- [ ] `/api/auth/session` returns the expected guilds only.
- [ ] CSRF-protected write from the dashboard succeeds; a cross-origin write is rejected.
- [ ] SSE updates arrive after a configuration change.
- [ ] `/t77 status` reports healthy gateway, commands, PostgreSQL, and Redis.
- [ ] Anti-Nuke, Anti-Raid, AutoMod, and Beast Mode remain in observation mode.
- [ ] A manual backup is captured and its checksum verified.
- [ ] A restore preview lists unsupported data before any restore is confirmed.
- [ ] Worker logs show schedule evaluation and no credential errors.
- [ ] PostgreSQL and Redis backups are scheduled and tested.
- [ ] Logs contain no bot token, client secret, encryption key, or session token.

---

## 12. Live drills still required

These cannot be completed without a private guild and real credentials:

1. Gateway connection with both privileged intents.
2. Moderation hierarchy boundaries: owner, equal-role, higher-role, self, and bot targets.
3. Anti-Nuke detection against a controlled destructive action in observation mode.
4. Anti-Raid join burst in a private guild with verification-gated quarantine.
5. AutoMod warning and timeout policy for a high-confidence rule.
6. Verification challenge issue, pass, expiry, and quarantine release.
7. Manual and scheduled backup capture, object checksum, restore preview, and restore execution.
8. S3-compatible storage against the chosen provider.
9. OAuth login, session expiry, logout, and revocation against the production Discord application.
10. Multi-process SSE and Redis Pub/Sub delivery.

Record the results before enabling `ENFORCE_REVERSIBLE` or `ENFORCE_DESTRUCTIVE`, and obtain explicit owner approval in writing.

---

## 13. Operations

- Monitor `/readyz` for every process.
- Alert on repeated dashboard action failures; the bot marks stale `RUNNING` actions as `FAILED` on restart.
- Review audit logs for `dashboard.action.*`, `config.updated`, enforcement approval/revocation, whitelist changes, staff grants, and backup/restore transitions.
- Rotate OAuth credentials and secrets by updating the environment and restarting the API; rotating `ENCRYPTION_KEY` invalidates stored OAuth tokens and forces re-login.
- Back up PostgreSQL daily and object storage according to the chosen provider.
- Keep the bot's role position above moderated roles; Discord rejects hierarchy-violating actions and T77 records them.
- Upgrade dependencies deliberately, then rerun `pnpm audit --prod`, `pnpm check`, and a restore preview drill.

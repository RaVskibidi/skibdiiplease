# T77 - Phase 10: Stabilisation, Audit, and Delivery

**Status:** Complete for everything provable in this environment. Live Discord, Docker, and S3 drills remain outstanding and are listed below. No result is fabricated.

---

## 1. Scope

- Fix type, lint, and formatting failures across all workspaces.
- Run unit, integration, production build, empty-database migration, Redis, tenant-isolation, permission-boundary, and engine-interaction checks.
- Review error handling, secret exposure, memory/performance characteristics, dependency vulnerabilities, and Docker definitions.
- Update the README, phase documentation, environment examples, and production deployment guide.
- Organise the finished project into two runnable folders on the Desktop.

---

## 2. Fixes made in this phase

| Area | Fix |
| --- | --- |
| Root build | `pnpm build` now builds web, API, bot, and worker instead of only the bot |
| Build race | Recursive builds run serially so four processes cannot run `prisma generate` concurrently |
| API routes | Module PATCH routes now parse request bodies with their Zod schemas instead of passing `any` |
| API types | Express `import()` annotations replaced with imported types; unused imports removed |
| Lint config | Test files get targeted relaxations for async doubles, `unbound-method`, and supertest `any` bodies; production rules remain strict |
| Bot | Unused imports, a non-async `report` helper, and a dead variable removed |
| Dashboard | Unused assignment in the SSE listener removed; `VITE_API_URL` is now actually honored |
| Web tests | Added a web unit test file so the workspace test script has real coverage |
| Docker | Bot image now copies the `@t77/security-core` workspace package, which was missing and would have broken the image build |
| Docs | README rewritten for Phases 7-10; Phase 9 report, deployment guide, and this report added |
| Artifacts | Stray root-level `*.log` files removed |

Formatting was applied with Prettier; no functional code was changed by the format pass.

---

## 3. Validation results

All commands were run from the repository root on Windows with Node 26 and pnpm 10.34.9.

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | Pass (7 projects) |
| Lint | `pnpm lint` | Pass, 0 errors, 0 warnings |
| Format | `pnpm format:check` | Pass |
| Unit tests | `pnpm test` | 44 files, 419 tests, all pass |
| Build | `pnpm build` | web, api, bot, worker all succeed |
| Integration tests | `pnpm --filter @t77/db test:integration` | 12 files, 85 tests, all pass |
| Empty-database migrations | integration global setup | 8 migrations apply from a dropped schema |
| Redis | integration suite | Pass against test Redis DB 15 |
| Production dependency audit | `pnpm audit --prod` | 0 vulnerabilities |

Per-suite unit counts:

| Suite | Files | Tests |
| --- | --- | --- |
| shared | 2 | 9 |
| security-core | 7 | 124 |
| db (unit) | 6 | 37 |
| api | 5 | 45 |
| bot | 22 | 194 |
| worker | 1 | 6 |
| web | 1 | 4 |
| **Total** | **44** | **419** |

Integration coverage (12 files, 85 tests) includes configuration versioning, tenant isolation, audit append-only enforcement, moderation case sequencing, whitelists, incidents, resources, Anti-Nuke state, backups, restore jobs, dashboard actions, and the full migration chain.

### Verification from the delivered folders

Checks were re-run from the final Desktop locations after `pnpm install`:

| Folder | Typecheck / lint / format | Unit tests | Integration tests | Build |
| --- | --- | --- | --- | --- |
| `Website` | Pass | 5 projects, 219 tests | Not re-run there (same `@t77/db` package; suite passed from `Bot`) | web + API |
| `Bot` | Pass | 5 projects, 370 tests | 12 files, 85 tests, from an empty schema with Redis | bot + worker |

### Build sizes

| Artifact | Size |
| --- | --- |
| `apps/web/dist` JS | 373.94 kB (109.42 kB gzip) |
| `apps/web/dist` CSS | 34.19 kB (6.87 kB gzip) |
| `apps/api/dist/index.js` | 5.80 MB |
| `apps/bot/dist/index.js` | 6.17 MB |
| `apps/worker/dist/index.js` | 5.63 MB |

---

## 4. Error, secret, and performance review

### Errors

- API errors use stable public codes; unexpected errors are logged with a request ID and return a generic 500.
- Startup validates the environment and fails fast rather than running half-configured.
- The bot records failed dashboard actions, marks stale `RUNNING` actions as failed on restart, and never silently drops a claimed action.
- Moderation cases are written before the Discord call and closed as `REVERSED` on failure, so a failed action is visible rather than lost.
- Discord hierarchy and bot permission checks run immediately before every action.

### Secrets

- No `.env` file is present in the repository and no token-like literal was found in source.
- OAuth access/refresh tokens are AES-256-GCM ciphertext with per-record IVs and auth tags.
- Session tokens are random and stored only as SHA-256 hashes.
- Logs redact known secret fields; the logger is never given the bot token.
- The web bundle contains no server secrets; only `VITE_*` values are exposed.
- `.gitignore` excludes `.env`, `.env.*`, logs, and generated Prisma output.

### Performance and memory

- All list endpoints clamp page sizes (`parseLimit`) and repositories cap query sizes.
- Redis keys and windows have bounded TTLs; security state uses atomic Lua scripts.
- AutoMod retains a bounded message window rather than unbounded history.
- The dashboard action listener processes at most 10 actions per tick and polls every 2 seconds; it does not allocate per-guild timers.
- SSE forwards events without buffering at the proxy only when `proxy_buffering off` is configured (documented in the deployment guide).
- The API request body limit is 256 KB.
- No unbounded in-process caches were introduced; guild access is cached in Redis with a 60-second TTL.

No memory profile under sustained production load was executed; this is static review plus bounded-design inspection.

---

## 5. Dependency audit

- `pnpm audit --prod`: **0 vulnerabilities**.
- Full `pnpm audit`: **1 moderate, development-only** advisory in `minimatch` pulled transitively by `typescript-eslint` -> `@typescript-eslint/typescript-estree`. It is a lint-time tool and is not included in production bundles or runtime dependencies. Pinning an override was not applied because the advisory is not reachable in production and an override could destabilise the lint toolchain. Revisit when `typescript-eslint` ships a patched dependency.

---

## 6. Docker review

The bot Dockerfile was corrected to include `packages/security-core`, which the bot imports and the previous image did not copy.

Status:

- `compose.yaml` defines PostgreSQL 16, Redis 7, and an optional bot profile with health checks.
- The bot image builds the workspace, generates Prisma, bundles with tsup, and runs as a non-root user with a `/readyz` health check.
- **Docker was not available in this environment.** The compose file and Dockerfile are reviewed but were not built or executed.
- There are no Dockerfiles for the API, web, or worker. They are documented as separately deployed Node/static services in `docs/deployment.md`.

Outstanding Docker work:

1. `docker compose build`.
2. Start PostgreSQL and Redis and confirm health checks.
3. Build and start the bot profile with a real `.env`.
4. Add API, web, and worker images and a reverse-proxy service if a fully containerised deployment is required.
5. Confirm the container runs as non-root and reads no secrets from the image.

---

## 7. Known limitations

Carried forward and accepted:

- No live Discord gateway, OAuth, moderation hierarchy, Anti-Nuke, Anti-Raid, AutoMod, verification, or backup/restore drill was executed here; these require a private guild, real credentials, and explicit authorization.
- No destructive enforcement is enabled or approved. The default remains observation.
- Docker/Compose was not executed.
- No Playwright/browser end-to-end suite is installed.
- S3-compatible storage was unit tested but not exercised against a live bucket.
- Role-based T77 grants are enforced by the bot, not by the API.
- Restored roles and channels receive new Discord IDs. Messages, members, bans, invites, audit logs, webhooks, and application commands are not recoverable.
- Cross-account verification rate limiting is not implemented beyond per-challenge attempt limits.
- One development-only dependency advisory remains (see section 5).

None of these limitations is presented as a passing live test.

---

## 8. Delivery layout

The finished project is organised on the Desktop as:

```text
T77 SEC BOT/
├── Website/   dashboard (web + API), its own workspace, docs, and env example
└── Bot/       bot + worker, its own workspace, docs, and env example
```

Each folder is independently installable and runnable. Neither folder contains a nested duplicate of the other or real secrets. Both include the shared packages they import, the Prisma schema and migrations, documentation, and `.env.example` files. `node_modules`, build output, and the generated Prisma client are local artifacts recreated by `pnpm install` and `pnpm check`.

See `T77 SEC BOT/README.md` for the top-level instructions.

---

## 9. Manual steps required for a real deployment

1. Provision PostgreSQL 16 and Redis 7.
2. Create a Discord application with bot and OAuth2 credentials.
3. Enable Server Members and Message Content intents.
4. Fill `.env` from `.env.example`; use unique secrets.
5. Run `pnpm install`, `pnpm db:migrate`, `pnpm check`, and `pnpm build`.
6. Start the bot, API, worker, and web server.
7. Complete the rollout checklist and live drills in `docs/deployment.md`.
8. Only then request explicit owner approval before enabling destructive enforcement.

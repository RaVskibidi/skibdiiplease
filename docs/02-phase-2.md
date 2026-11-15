# T77 — Phase 2 Implementation Notes

**Status:** Implemented and validated locally.
**Scope:** Project initialization, Discord bot core, command/event/interaction frameworks, logging, environment validation, branding, health checks, and Docker development infrastructure.

## Implemented

- pnpm workspace with `@t77/bot` and `@t77/shared`.
- Strict TypeScript configuration shared across packages.
- ESLint flat config with type-aware rules and Prettier integration.
- Discord.js v14 client with:
  - Guilds, Guild Members, Guild Moderation, Guild Messages, and Message Content intents.
  - Channel, Guild Member, and Message partials.
  - Safe default mention policy.
- Slash command framework:
  - Duplicate protection.
  - Command metadata and categories.
  - Discord command payload validation through builders.
  - Global or development-guild registration.
  - Registration state exposed to status and health checks.
- Interaction framework:
  - Slash commands with cooldowns.
  - Autocomplete routing.
  - Button, modal, and select-menu routing by longest matching `t77:` prefix.
  - Typed component handler contexts.
- Typed event registry with once support, error containment, and structured event logging.
- Core commands:
  - `/t77 help` — live command reference, public to server members.
  - `/t77 status` — gateway/runtime/command status, owner or Manage Server only.
- T77 branding:
  - Original shield SVG.
  - Brand colors and identity.
  - Embed factory with Discord limit enforcement.
  - Error, warning, success, and info embeds.
  - Branded button and confirmation-row factories.
- Structured logging:
  - Pino JSON in production.
  - Pretty output in development.
  - Secret redaction and error serialization.
  - Request IDs for interactions.
- Environment:
  - Zod validation.
  - Safe, path-based error reporting.
  - Finder for the nearest `.env`.
  - `.env.example` with no real credentials.
- Lifecycle:
  - Health server at `/healthz` and `/readyz`.
  - Graceful SIGINT/SIGTERM shutdown.
  - Hard shutdown deadline.
  - Process-level uncaught exception and unhandled rejection handling.
- Docker:
  - Node 24 multi-stage bot image.
  - PostgreSQL 16 and Redis 7 development services.
  - Optional bot profile.
  - Container health check against `/readyz`.
- Tests:
  - Environment validation.
  - Cooldowns.
  - Command registration and failure states.
  - Event dispatch, once handlers, and error containment.
  - Interaction routing, permissions failures, cooldowns, and component prefixes.
  - Branding and Discord component limits.
  - Help/status presentation.
  - Health readiness and HTTP behavior.
  - Shared formatting and domain errors.

## Files created

```text
t77/package.json
t77/pnpm-workspace.yaml
t77/tsconfig.base.json
t77/eslint.config.mjs
t77/.prettierrc.json
t77/.prettierignore
t77/.editorconfig
t77/.npmrc
t77/.gitignore
t77/.dockerignore
t77/.env.example
t77/compose.yaml
t77/README.md
t77/assets/t77-shield.svg
t77/infra/docker/bot.Dockerfile
t77/docs/02-phase-2.md
t77/packages/shared/package.json
t77/packages/shared/tsconfig.json
t77/packages/shared/vitest.config.ts
t77/packages/shared/src/index.ts
t77/packages/shared/src/branding/colors.ts
t77/packages/shared/src/branding/identity.ts
t77/packages/shared/src/errors.ts
t77/packages/shared/src/format.ts
t77/packages/shared/test/errors.test.ts
t77/packages/shared/test/format.test.ts
t77/apps/bot/package.json
t77/apps/bot/tsconfig.json
t77/apps/bot/tsup.config.ts
t77/apps/bot/vitest.config.ts
t77/apps/bot/src/index.ts
t77/apps/bot/src/bootstrap/application.ts
t77/apps/bot/src/bootstrap/client.ts
t77/apps/bot/src/bootstrap/env.ts
t77/apps/bot/src/bootstrap/health.ts
t77/apps/bot/src/bootstrap/logger.ts
t77/apps/bot/src/bootstrap/shutdown.ts
t77/apps/bot/src/branding/components.ts
t77/apps/bot/src/branding/embeds.ts
t77/apps/bot/src/commands/t77/help.ts
t77/apps/bot/src/commands/t77/index.ts
t77/apps/bot/src/commands/t77/status.ts
t77/apps/bot/src/core/cooldown.ts
t77/apps/bot/src/core/errors.ts
t77/apps/bot/src/core/commands/command-registry.ts
t77/apps/bot/src/core/commands/types.ts
t77/apps/bot/src/core/events/event-registry.ts
t77/apps/bot/src/core/events/types.ts
t77/apps/bot/src/core/interactions/interaction-router.ts
t77/apps/bot/src/core/interactions/types.ts
t77/apps/bot/src/events/guild-lifecycle.ts
t77/apps/bot/src/events/interaction-create.ts
t77/apps/bot/src/events/lifecycle.ts
t77/apps/bot/src/events/ready.ts
t77/apps/bot/test/branding.test.ts
t77/apps/bot/test/command-presentation.test.ts
t77/apps/bot/test/command-registry.test.ts
t77/apps/bot/test/cooldown.test.ts
t77/apps/bot/test/env.test.ts
t77/apps/bot/test/event-registry.test.ts
t77/apps/bot/test/health.test.ts
t77/apps/bot/test/interaction-router.test.ts
```

## Verification results

- `pnpm typecheck` — passes.
- `pnpm lint` — passes.
- `pnpm test` — 8 bot test files, 46 bot tests; 2 shared test files, 9 shared tests; all passing.
- `pnpm build` — tsup build succeeds.
- Compiled bot entry point fails fast with a clear environment error when no token is configured.

## Known limitations / unfinished work

- Live Discord gateway connection and command registration require a real bot token and private test guild. They were not executed without credentials.
- Docker was unavailable in the development environment. Compose syntax and the production deploy layout were checked, but containers were not started.
- The API, web dashboard, worker, PostgreSQL schema, and Redis integration are Phase 3+ work and are not scaffolded as empty placeholders.
- The in-memory cooldown store is correct for a single bot process. Distributed rate limiting arrives with Redis in a later phase.
- `/t77 help` and `/t77 status` are the only commands in Phase 2. No security controls are exposed before their engines exist.
- Command registration visibility is controlled by Discord builders; authorization is always enforced server-side.

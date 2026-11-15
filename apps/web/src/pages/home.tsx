import { Link, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';

import { useAuth } from '../auth.js';
import { api } from '../api.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  ShieldMark,
  Spinner,
  Stat,
} from '../components/ui.js';

interface Health {
  status: string;
  timestamp: string;
}

export function LoginPage(): React.JSX.Element {
  const [params] = useSearchParams();
  const authError = params.get('authError');

  const errors: Record<string, string> = {
    invalid_transaction: 'The Discord sign-in attempt expired. Start again.',
    exchange_failed:
      'Discord rejected the sign-in. Check the OAuth redirect URI and client secret.',
    access_denied: 'You cancelled the Discord authorization.',
  };

  return (
    <div className="t77-grid flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-5xl overflow-hidden rounded-3xl border border-edge bg-panel/80 shadow-2xl">
        <div className="grid lg:grid-cols-[1.1fr_0.9fr]">
          <div className="p-8 sm:p-12">
            <div className="flex items-center gap-3">
              <ShieldMark className="h-12 w-12" />
              <div>
                <p className="text-lg font-bold tracking-[0.3em]">T77</p>
                <p className="text-[10px] uppercase tracking-[0.24em] text-ash">
                  Security control plane
                </p>
              </div>
            </div>
            <h1 className="mt-10 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
              One console for Discord
              <span className="text-blood-soft"> defence.</span>
            </h1>
            <p className="mt-4 max-w-lg text-sm leading-relaxed text-ash">
              Anti-nuke, anti-raid, Beast Mode, AutoMod, verification, moderation, backups, and
              audit history. Every dashboard action is authorized through Discord and executed by
              the T77 bot, never directly by the web tier.
            </p>

            {authError !== null && (
              <p className="mt-6 rounded-lg border border-blood/40 bg-blood/10 px-4 py-3 text-sm text-blood-soft">
                {errors[authError] ?? 'Discord sign-in could not be completed.'}
              </p>
            )}

            <a
              href="/api/auth/discord"
              className="mt-8 inline-flex items-center gap-2 rounded-lg border border-blood/70 bg-blood px-5 py-3 text-sm font-semibold text-white shadow-[0_10px_30px_-12px_rgba(225,29,46,.9)] transition hover:bg-blood-soft"
            >
              Sign in with Discord
            </a>
            <p className="mt-3 text-[11px] text-ash">
              Scopes requested: identify and guilds. T77 never sees your Discord password and never
              asks for the bot token.
            </p>
          </div>

          <aside className="border-t border-edge bg-[#0b0c10]/70 p-8 lg:border-l lg:border-t-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ash">
              Operating principles
            </p>
            <ul className="mt-4 space-y-4 text-xs leading-relaxed text-ash">
              <li className="border-l-2 border-blood/60 pl-3">
                <span className="block font-semibold text-chalk">Observation first</span>
                New installations never apply destructive enforcement until the server owner
                approves.
              </li>
              <li className="border-l-2 border-edge-strong pl-3">
                <span className="block font-semibold text-chalk">Guild isolation</span>
                Every query is tenant scoped. A session for one server cannot read another.
              </li>
              <li className="border-l-2 border-edge-strong pl-3">
                <span className="block font-semibold text-chalk">Honest recovery</span>
                Backups capture only Discord configuration the API exposes. Messages and members are
                never claimed as recoverable.
              </li>
              <li className="border-l-2 border-edge-strong pl-3">
                <span className="block font-semibold text-chalk">Auditable actions</span>
                Dashboard requests are queued, executed by the bot, and recorded in the audit trail.
              </li>
            </ul>
          </aside>
        </div>
      </div>
    </div>
  );
}

export function HomePage(): React.JSX.Element {
  const { session, loading, error, refresh } = useAuth();
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    if (session === null) {
      return;
    }
    void fetch('/healthz', { credentials: 'include' })
      .then((response) => (response.ok ? (response.json() as Promise<Health>) : null))
      .then((value) => setHealth(value))
      .catch(() => setHealth(null));
  }, [session]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="Loading T77" />
      </div>
    );
  }

  if (session === null) {
    return <LoginPage />;
  }

  const installed = session.guilds.filter((guild) => guild.botPresent);
  const pending = session.guilds.filter((guild) => !guild.botPresent);

  return (
    <div className="t77-grid min-h-screen px-4 py-8 sm:px-8">
      <div className="mx-auto w-full max-w-6xl">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-edge pb-6">
          <div className="flex items-center gap-3">
            <ShieldMark className="h-11 w-11" />
            <div>
              <p className="text-base font-bold tracking-[0.3em]">T77</p>
              <p className="text-[10px] uppercase tracking-[0.2em] text-ash">
                Security control plane
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-ash">
            <span>
              {session.user.globalName ?? session.user.username}
              {session.user.globalName !== null ? ` (@${session.user.username})` : ''}
            </span>
            <Button
              variant="ghost"
              onClick={() => {
                void api.post('/auth/logout').then(() => refresh());
              }}
            >
              Sign out
            </Button>
          </div>
        </header>

        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          <Stat label="Manageable servers" value={session.guilds.length} />
          <Stat label="T77 installed" value={installed.length} tone="good" />
          <Stat
            label="API"
            value={health?.status ?? 'unknown'}
            tone={health?.status === 'ok' ? 'good' : 'warn'}
            hint={
              health?.timestamp === undefined
                ? undefined
                : new Date(health.timestamp).toLocaleTimeString()
            }
          />
        </div>

        {error !== null && (
          <p className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            {error}
          </p>
        )}

        <div className="mt-8">
          <PageHeader
            eyebrow="Server selection"
            title="Choose a server"
            description="Only servers where you have Manage Server or Administrator are listed. T77 must be installed before its modules can be configured."
          />
          {session.guilds.length === 0 ? (
            <EmptyState
              title="No manageable servers"
              description="Your Discord account does not manage any servers, or the guilds scope was not granted. Sign in again and approve the requested scopes."
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {[...installed, ...pending].map((guild) => (
                <div
                  key={guild.id}
                  className="flex items-center gap-4 rounded-2xl border border-edge bg-panel/85 p-4"
                >
                  {guild.iconUrl !== null ? (
                    <img src={guild.iconUrl} alt="" className="h-12 w-12 rounded-xl" />
                  ) : (
                    <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-edge-strong bg-black/40 text-sm font-bold">
                      {guild.name.slice(0, 2).toUpperCase()}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{guild.name}</p>
                    <div className="mt-1 flex items-center gap-2">
                      {guild.botPresent ? (
                        <Badge tone="good">T77 installed</Badge>
                      ) : (
                        <Badge tone="warn">Bot not installed</Badge>
                      )}
                      {guild.owner && <Badge tone="info">Owner</Badge>}
                    </div>
                  </div>
                  {guild.botPresent ? (
                    <Link
                      to={`/servers/${guild.id}/security`}
                      className="rounded-lg border border-edge-strong bg-panel-2 px-3 py-2 text-xs font-semibold hover:border-blood/60"
                    >
                      Open
                    </Link>
                  ) : (
                    <a
                      href={`https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(
                        import.meta.env.VITE_DISCORD_CLIENT_ID ?? '',
                      )}&scope=bot%20applications.commands&guild_id=${guild.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-lg border border-edge-strong bg-panel-2 px-3 py-2 text-xs font-semibold hover:border-blood/60"
                    >
                      Install
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <Card title="Owner-gated enforcement">
            <p className="text-xs leading-relaxed text-ash">
              Destructive automation stays disabled until the Discord server owner approves it in
              Settings. Observation mode is always available.
            </p>
          </Card>
          <Card title="Queued Discord actions">
            <p className="text-xs leading-relaxed text-ash">
              Backup and emergency actions are never executed by the API. They are written to a
              queue and claimed by the bot, which holds the Discord token.
            </p>
          </Card>
          <Card title="Append-only audit">
            <p className="text-xs leading-relaxed text-ash">
              Configuration, moderation, security, and dashboard events are recorded in an
              append-only audit trail per server.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}

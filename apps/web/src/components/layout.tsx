import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { createContext, useContext, useEffect, useState } from 'react';

import { useAuth } from '../auth.js';
import { useGuildEvents } from '../hooks.js';
import { ShieldMark, Button } from './ui.js';

export interface LiveEvent {
  readonly type: string;
  readonly payload: unknown;
  readonly at: number;
}

const LiveEventContext = createContext<LiveEvent | null>(null);

export function useLiveEvent(): LiveEvent | null {
  return useContext(LiveEventContext);
}

const NAV: ReadonlyArray<{ to: string; label: string; glyph: string }> = [
  { to: 'overview', label: 'Overview', glyph: 'O' },
  { to: 'security', label: 'Security Status', glyph: 'S' },
  { to: 'anti-nuke', label: 'Anti-Nuke', glyph: 'N' },
  { to: 'anti-raid', label: 'Anti-Raid', glyph: 'R' },
  { to: 'beast-mode', label: 'Beast Mode', glyph: 'B' },
  { to: 'anti-spam', label: 'Anti-Spam', glyph: 'P' },
  { to: 'automod', label: 'AutoMod', glyph: 'A' },
  { to: 'verification', label: 'Verification', glyph: 'V' },
  { to: 'whitelist', label: 'Whitelist', glyph: 'W' },
  { to: 'moderation', label: 'Moderation', glyph: 'M' },
  { to: 'bot-protection', label: 'Bot Protection', glyph: 'T' },
  { to: 'backups', label: 'Backups', glyph: 'C' },
  { to: 'audit-logs', label: 'Audit Logs', glyph: 'L' },
  { to: 'staff', label: 'Staff', glyph: 'G' },
  { to: 'settings', label: 'Settings', glyph: '⚙' },
];

export function GuildLayout(): React.JSX.Element {
  const { guildId = '' } = useParams();
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [liveEvent, setLiveEvent] = useState<LiveEvent | null>(null);

  const guild = session?.guilds.find((item) => item.id === guildId) ?? null;

  useGuildEvents(guildId, (type, payload) => {
    setLiveEvent({ type, payload, at: Date.now() });
  });

  useEffect(() => {
    setOpen(false);
  }, [guildId]);

  return (
    <div className="min-h-screen lg:flex">
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 border-r border-edge bg-[#0a0b0e]/95 p-4 backdrop-blur transition-transform lg:static lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <NavLink to="/" className="flex items-center gap-3 rounded-xl px-2 py-2">
          <ShieldMark />
          <span>
            <span className="block text-sm font-bold tracking-[0.22em]">T77</span>
            <span className="block text-[10px] uppercase tracking-[0.2em] text-ash">Security</span>
          </span>
        </NavLink>

        <div className="mt-5 rounded-xl border border-edge bg-panel px-3 py-3">
          <p className="text-[10px] uppercase tracking-[0.16em] text-ash">Active server</p>
          <p className="mt-1 truncate text-sm font-semibold">{guild?.name ?? 'Unknown server'}</p>
          <button
            type="button"
            className="mt-2 text-[11px] font-semibold text-blood-soft hover:underline"
            onClick={() => navigate('/')}
          >
            Switch server
          </button>
        </div>

        <nav className="t77-scroll mt-4 max-h-[calc(100vh-290px)] space-y-1 overflow-y-auto pr-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-xs font-medium transition ${
                  isActive
                    ? 'bg-blood/15 text-chalk shadow-[inset_2px_0_0_#e11d2e]'
                    : 'text-ash hover:bg-white/5 hover:text-chalk'
                }`
              }
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-md border border-edge-strong bg-black/40 text-[10px] font-bold text-ash">
                {item.glyph}
              </span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-4 border-t border-edge pt-3 text-[10px] leading-relaxed text-ash/70">
          T77 never activates destructive enforcement without the server owner's explicit approval.
        </div>
      </aside>

      {open && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-edge bg-void/80 px-4 py-3 backdrop-blur lg:px-7">
          <button
            type="button"
            className="rounded-lg border border-edge-strong px-2.5 py-1.5 text-xs lg:hidden"
            onClick={() => setOpen((value) => !value)}
          >
            Menu
          </button>
          <div className="flex min-w-0 items-center gap-2 text-xs text-ash">
            <span className="hidden sm:inline">Control plane</span>
            <span className="hidden text-edge-strong sm:inline">/</span>
            <span className="truncate font-semibold text-chalk">{guild?.name ?? 'T77'}</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-xs font-semibold">
                {session?.user.globalName ?? session?.user.username ?? 'Operator'}
              </p>
              <p className="text-[10px] text-ash">Discord operator</p>
            </div>
            {session?.user.avatarUrl !== null && session?.user.avatarUrl !== undefined ? (
              <img
                src={session.user.avatarUrl}
                alt=""
                className="h-8 w-8 rounded-full border border-edge-strong"
              />
            ) : (
              <span className="flex h-8 w-8 items-center justify-center rounded-full border border-edge-strong bg-panel text-xs font-bold">
                {(session?.user.username ?? 'T7').slice(0, 2).toUpperCase()}
              </span>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                void logout().then(() => navigate('/'));
              }}
            >
              Sign out
            </Button>
          </div>
        </header>

        <main className="t77-grid min-h-[calc(100vh-57px)] px-4 py-6 lg:px-7">
          <div className="mx-auto w-full max-w-6xl">
            <LiveEventContext.Provider value={liveEvent}>
              <Outlet />
            </LiveEventContext.Provider>
          </div>
        </main>
      </div>
    </div>
  );
}

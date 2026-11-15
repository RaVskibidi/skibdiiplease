import { Navigate, Route, Routes, useParams } from 'react-router-dom';

import { useAuth } from './auth.js';
import { GuildLayout } from './components/layout.js';
import { ToastProvider, Button, EmptyState, ShieldMark, Spinner } from './components/ui.js';
import { HomePage } from './pages/home.js';
import { OverviewPage } from './pages/overview.js';
import { SecurityPage } from './pages/security.js';
import { AntiNukePage } from './pages/anti-nuke.js';
import { AntiRaidPage } from './pages/anti-raid.js';
import { BeastModePage } from './pages/beast.js';
import { AutomodPage, AntiSpamPage } from './pages/automod.js';
import { VerificationPage } from './pages/verification.js';
import { WhitelistPage } from './pages/whitelist.js';
import { ModerationPage } from './pages/moderation.js';
import { BotProtectionPage } from './pages/bot-protection.js';
import { BackupsPage } from './pages/backups.js';
import { AuditLogsPage, StaffPage } from './pages/audit.js';
import { SettingsPage } from './pages/settings.js';

function RequireSession({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { session, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="Checking your Discord session" />
      </div>
    );
  }
  if (session === null) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

function GuildBoundary(): React.JSX.Element {
  const { guildId = '' } = useParams();
  const { session } = useAuth();
  const guild = session?.guilds.find((item) => item.id === guildId);
  if (guild === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <EmptyState
          title="Server not available"
          description="T77 is not installed in this server, or your Discord account no longer has Manage Server permission."
          action={
            <a
              href="/"
              className="rounded-lg border border-edge-strong bg-panel-2 px-3 py-2 text-xs font-semibold hover:border-blood/60"
            >
              Return to server list
            </a>
          }
        />
      </div>
    );
  }
  if (!guild.botPresent) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <EmptyState
          title="T77 is not in this server"
          description="Install the T77 bot in this server before configuring its modules."
          action={
            <a
              href="/"
              className="rounded-lg border border-edge-strong bg-panel-2 px-3 py-2 text-xs font-semibold hover:border-blood/60"
            >
              Back to servers
            </a>
          }
        />
      </div>
    );
  }
  return <GuildLayout />;
}

export function NotFoundPage(): React.JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="text-center">
        <ShieldMark className="mx-auto h-14 w-14" />
        <p className="mt-6 text-sm font-semibold uppercase tracking-[0.2em] text-ash">404</p>
        <h1 className="mt-2 text-2xl font-semibold">That page does not exist</h1>
        <p className="mt-2 text-sm text-ash">The link may be outdated or the route was mistyped.</p>
        <Button className="mt-5" onClick={() => window.location.assign('/')}>
          Return to T77
        </Button>
      </div>
    </div>
  );
}

export function App(): React.JSX.Element {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route
          path="/servers/:guildId"
          element={
            <RequireSession>
              <GuildBoundary />
            </RequireSession>
          }
        >
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="security" element={<SecurityPage />} />
          <Route path="anti-nuke" element={<AntiNukePage />} />
          <Route path="anti-raid" element={<AntiRaidPage />} />
          <Route path="beast-mode" element={<BeastModePage />} />
          <Route path="anti-spam" element={<AntiSpamPage />} />
          <Route path="automod" element={<AutomodPage />} />
          <Route path="verification" element={<VerificationPage />} />
          <Route path="whitelist" element={<WhitelistPage />} />
          <Route path="moderation" element={<ModerationPage />} />
          <Route path="bot-protection" element={<BotProtectionPage />} />
          <Route path="backups" element={<BackupsPage />} />
          <Route path="audit-logs" element={<AuditLogsPage />} />
          <Route path="staff" element={<StaffPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </ToastProvider>
  );
}

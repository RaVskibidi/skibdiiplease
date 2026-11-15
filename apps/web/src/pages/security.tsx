import { useEffect } from 'react';

import { Badge, Card, ErrorBanner, PageHeader, Spinner, Stat } from '../components/ui.js';
import { useGuildId, useFetch } from '../hooks.js';
import { useLiveEvent } from '../components/layout.js';
import { formatDate } from '../api.js';

interface SecurityResponse {
  security: { score: number; grade: string; openIncidents: number };
  config: {
    automationMode: string;
    antiNukeEnabled: boolean;
    antiRaidEnabled: boolean;
    beastModeEnabled: boolean;
    automodEnabled: boolean;
    verificationEnabled: boolean;
    botProtectionEnabled: boolean;
    loggingEnabled: boolean;
    backupsEnabled: boolean;
    enforcementApprovedAt: string | null;
  };
  incidents: Array<{
    id: string;
    type: string;
    severity: string;
    status: string;
    score: number;
    openedAt: string;
  }>;
  resources: Record<string, number>;
  logChannels: Array<{ category: string; channelId: string }>;
  botApprovals: Array<{ id: string; botId: string }>;
  backups: Array<{ id: string; status: string; type: string; createdAt: string }>;
  recommendations: Array<{ id: string; severity: string; message: string }>;
  unavailable: Array<{ id: string; message: string }>;
}

const MODULES: ReadonlyArray<[keyof SecurityResponse['config'], string, string]> = [
  ['antiNukeEnabled', 'Anti-Nuke', 'anti-nuke'],
  ['antiRaidEnabled', 'Anti-Raid', 'anti-raid'],
  ['beastModeEnabled', 'Beast Mode', 'beast-mode'],
  ['automodEnabled', 'AutoMod', 'automod'],
  ['verificationEnabled', 'Verification', 'verification'],
  ['botProtectionEnabled', 'Bot Protection', 'bot-protection'],
  ['loggingEnabled', 'Logging', 'settings'],
  ['backupsEnabled', 'Backups', 'backups'],
];

export function SecurityPage(): React.JSX.Element {
  const guildId = useGuildId();
  const state = useFetch<SecurityResponse>(`/guilds/${guildId}/security`);
  const live = useLiveEvent();

  useEffect(() => {
    if (live !== null && live.type !== 'ready') {
      void state.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.at]);

  if (state.loading && state.data === null) {
    return <Spinner label="Scanning stored security posture" />;
  }
  if (state.error !== null) {
    return <ErrorBanner message={state.error} />;
  }
  if (state.data === null) {
    return <ErrorBanner message="Security posture is unavailable." />;
  }

  const {
    security,
    config,
    incidents,
    resources,
    logChannels,
    botApprovals,
    backups,
    recommendations,
    unavailable,
  } = state.data;

  return (
    <div>
      <PageHeader
        eyebrow="Posture"
        title="Security Status"
        description="Stored configuration, open incidents, and backup readiness. Live role-permission and webhook audits require /t77 scan in Discord."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Security score"
          value={`${security.score}/100`}
          tone={security.score >= 75 ? 'good' : security.score >= 50 ? 'warn' : 'bad'}
          hint={`Grade ${security.grade}`}
        />
        <Stat
          label="Open incidents"
          value={security.openIncidents}
          tone={security.openIncidents > 0 ? 'bad' : 'good'}
        />
        <Stat
          label="Automation mode"
          value={config.automationMode.replace('ENFORCE_', 'ENFORCE ')}
        />
        <Stat
          label="Enforcement approval"
          value={config.enforcementApprovedAt === null ? 'Not approved' : 'Approved'}
          tone={config.enforcementApprovedAt === null ? 'warn' : 'good'}
          hint={
            config.enforcementApprovedAt === null
              ? undefined
              : formatDate(config.enforcementApprovedAt)
          }
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
        <Card
          title="Modules"
          description="Enabled state is the persisted configuration the bot reads."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {MODULES.map(([key, label, route]) => {
              const enabled = config[key] as boolean;
              return (
                <a
                  key={key}
                  href={`/servers/${guildId}/${route}`}
                  className="flex items-center justify-between rounded-xl border border-edge bg-[#0d0f13] px-4 py-3 transition hover:border-edge-strong"
                >
                  <span className="text-sm font-medium">{label}</span>
                  <Badge tone={enabled ? 'good' : 'neutral'}>
                    {enabled ? 'Active' : 'Disabled'}
                  </Badge>
                </a>
              );
            })}
          </div>
        </Card>

        <Card title="Recommendations" description="Derived only from stored configuration.">
          {recommendations.length === 0 ? (
            <p className="text-xs text-ash">No immediate configuration gaps detected.</p>
          ) : (
            <ul className="space-y-3">
              {recommendations.map((item) => (
                <li
                  key={item.id}
                  className="rounded-lg border border-edge bg-[#0d0f13] px-3 py-2.5"
                >
                  <div className="flex items-center gap-2">
                    <Badge
                      tone={
                        item.severity === 'HIGH'
                          ? 'bad'
                          : item.severity === 'MEDIUM'
                            ? 'warn'
                            : 'info'
                      }
                    >
                      {item.severity}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-ash">{item.message}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card
          title="Discord resources"
          description="Projection stored by the bot at startup and on join."
        >
          <dl className="space-y-2 text-sm">
            {['ROLE', 'CATEGORY', 'CHANNEL', 'EMOJI', 'STICKER'].map((key) => (
              <div
                key={key}
                className="flex items-center justify-between border-b border-edge/60 pb-1.5 last:border-0"
              >
                <dt className="text-xs uppercase tracking-wide text-ash">{key}</dt>
                <dd className="font-mono text-xs">{resources[key] ?? 0}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card title="Logging" description="Security events are routed to these channels.">
          <p className="text-2xl font-semibold">{logChannels.length}</p>
          <p className="mt-1 text-xs text-ash">configured log channels</p>
          <ul className="mt-3 space-y-1.5 font-mono text-[11px] text-ash">
            {logChannels.slice(0, 6).map((channel) => (
              <li key={`${channel.category}:${channel.channelId}`}>
                {channel.category} → {channel.channelId}
              </li>
            ))}
            {logChannels.length === 0 && <li>No channels configured.</li>}
          </ul>
        </Card>

        <Card title="Approved bots & backups">
          <p className="text-xs text-ash">Approved bots</p>
          <p className="text-2xl font-semibold">{botApprovals.length}</p>
          <p className="mt-3 text-xs text-ash">Recent backups</p>
          {backups.length === 0 ? (
            <p className="mt-1 text-xs text-ash">No backups captured yet.</p>
          ) : (
            <ul className="mt-1 space-y-1 text-[11px] text-ash">
              {backups.map((backup) => (
                <li key={backup.id} className="flex items-center justify-between gap-2">
                  <span>{backup.type}</span>
                  <Badge
                    tone={
                      backup.status === 'READY'
                        ? 'good'
                        : backup.status === 'FAILED'
                          ? 'bad'
                          : 'neutral'
                    }
                  >
                    {backup.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        className="mt-6"
        title="Recent incidents"
        description="Security incidents recorded by T77. New incidents stream live when Redis is connected."
      >
        {incidents.length === 0 ? (
          <p className="text-xs text-ash">No incidents recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="t77-table w-full">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Severity</th>
                  <th>Status</th>
                  <th>Score</th>
                  <th>Opened</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((incident) => (
                  <tr key={incident.id}>
                    <td className="font-medium">{incident.type}</td>
                    <td>
                      <Badge tone={incident.severity === 'CRITICAL' ? 'bad' : 'warn'}>
                        {incident.severity}
                      </Badge>
                    </td>
                    <td>{incident.status}</td>
                    <td className="font-mono">{incident.score}</td>
                    <td className="text-ash">{formatDate(incident.openedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        className="mt-6"
        title="Not available from stored data"
        description="T77 does not invent results it cannot verify."
      >
        <ul className="space-y-2">
          {unavailable.map((item) => (
            <li
              key={item.id}
              className="rounded-lg border border-edge bg-[#0d0f13] px-3 py-2.5 text-xs text-ash"
            >
              {item.message}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

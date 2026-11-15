import { Link } from 'react-router-dom';
import { useEffect } from 'react';

import { Badge, Card, ErrorBanner, PageHeader, Spinner, Stat } from '../components/ui.js';
import { useFetch, useGuildId } from '../hooks.js';
import { useLiveEvent } from '../components/layout.js';
import { formatDate } from '../api.js';

interface OverviewResponse {
  guild: {
    id: string;
    name: string;
    iconUrl: string | null;
    memberCount: number;
    ownerId: string;
    botJoinedAt: string;
  };
  security: { score: number; grade: string; openIncidents: number };
  modules: Array<{ id: string; enabled: boolean; state: string }>;
  enforcement: {
    automationMode: string;
    approvedAt: string | null;
    approvedBy: string | null;
  };
  incidents: Array<{
    id: string;
    type: string;
    severity: string;
    status: string;
    openedAt: string;
  }>;
  cases: Array<{
    id: string;
    number: number;
    type: string;
    targetId: string;
    status: string;
    createdAt: string;
  }>;
  events: Array<{ id: string; type: string; severity: string; occurredAt: string }>;
  resources: Record<string, number>;
  actions: Array<{ id: string; type: string; status: string; createdAt: string }>;
  generatedAt: string;
}

export function OverviewPage(): React.JSX.Element {
  const guildId = useGuildId();
  const state = useFetch<OverviewResponse>(`/guilds/${guildId}/overview`);
  const live = useLiveEvent();

  useEffect(() => {
    if (live !== null && live.type !== 'ready') {
      void state.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.at]);

  if (state.loading && state.data === null) {
    return <Spinner label="Building server overview" />;
  }
  if (state.error !== null) {
    return <ErrorBanner message={state.error} />;
  }
  if (state.data === null) {
    return <ErrorBanner message="Overview is unavailable." />;
  }

  const data = state.data;

  return (
    <div>
      <PageHeader
        eyebrow="Overview"
        title={data.guild.name}
        description={`${data.guild.memberCount.toLocaleString()} members · T77 joined ${formatDate(data.guild.botJoinedAt)} · snapshot ${formatDate(data.generatedAt)}`}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Security score"
          value={`${data.security.score}/100`}
          tone={data.security.score >= 75 ? 'good' : data.security.score >= 50 ? 'warn' : 'bad'}
          hint={`Grade ${data.security.grade}`}
        />
        <Stat
          label="Open incidents"
          value={data.security.openIncidents}
          tone={data.security.openIncidents > 0 ? 'bad' : 'good'}
        />
        <Stat
          label="Automation"
          value={data.enforcement.automationMode.replace('ENFORCE_', 'ENFORCE ')}
        />
        <Stat
          label="Tracked resources"
          value={Object.values(data.resources).reduce((sum, value) => sum + value, 0)}
          hint="roles, channels, emojis, stickers"
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        <Card
          title="Modules"
          description="Persisted module state. Open a module to change its policy."
        >
          <div className="grid gap-2">
            {data.modules.map((module) => (
              <Link
                key={module.id}
                to={`/servers/${guildId}/${module.id}`}
                className="flex items-center justify-between rounded-lg border border-edge bg-[#0d0f13] px-3 py-2 text-xs hover:border-edge-strong"
              >
                <span className="font-medium">{module.id}</span>
                <Badge tone={module.enabled ? 'good' : 'neutral'}>
                  {module.enabled ? 'Active' : 'Disabled'}
                </Badge>
              </Link>
            ))}
          </div>
        </Card>

        <div className="space-y-6">
          <Card
            title="Recent security events"
            description="Newest events recorded by the security engines."
          >
            {data.events.length === 0 ? (
              <p className="text-xs text-ash">No events recorded.</p>
            ) : (
              <ul className="space-y-2">
                {data.events.slice(0, 6).map((event) => (
                  <li
                    key={event.id}
                    className="flex items-center justify-between rounded-lg border border-edge bg-[#0d0f13] px-3 py-2 text-xs"
                  >
                    <span className="font-medium">{event.type}</span>
                    <span className="flex items-center gap-2 text-ash">
                      <Badge tone={event.severity === 'CRITICAL' ? 'bad' : 'warn'}>
                        {event.severity}
                      </Badge>
                      {formatDate(event.occurredAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Recent moderation cases">
            {data.cases.length === 0 ? (
              <p className="text-xs text-ash">No moderation cases.</p>
            ) : (
              <ul className="space-y-2">
                {data.cases.slice(0, 6).map((record) => (
                  <li
                    key={record.id}
                    className="flex items-center justify-between rounded-lg border border-edge bg-[#0d0f13] px-3 py-2 text-xs"
                  >
                    <span>
                      <span className="font-mono">#{record.number}</span> {record.type}
                    </span>
                    <span className="flex items-center gap-2 text-ash">
                      <Badge tone={record.status === 'OPEN' ? 'info' : 'neutral'}>
                        {record.status}
                      </Badge>
                      {formatDate(record.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <Card
        className="mt-6"
        title="Queued dashboard actions"
        description="Requests wait here until the T77 bot claims them. If the bot is offline they remain pending."
      >
        {data.actions.length === 0 ? (
          <p className="text-xs text-ash">No queued actions.</p>
        ) : (
          <ul className="space-y-2">
            {data.actions.map((action) => (
              <li
                key={action.id}
                className="flex items-center justify-between rounded-lg border border-edge bg-[#0d0f13] px-3 py-2 text-xs"
              >
                <span className="font-mono text-[11px]">{action.type}</span>
                <span className="flex items-center gap-2 text-ash">
                  <Badge
                    tone={
                      action.status === 'COMPLETED'
                        ? 'good'
                        : action.status === 'FAILED'
                          ? 'bad'
                          : action.status === 'RUNNING'
                            ? 'info'
                            : 'warn'
                    }
                  >
                    {action.status}
                  </Badge>
                  {formatDate(action.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

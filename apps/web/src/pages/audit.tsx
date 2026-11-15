import { useEffect, useState } from 'react';

import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorBanner,
  Field,
  PageHeader,
  Select,
  Spinner,
  TextInput,
  useToast,
} from '../components/ui.js';
import { useFetch, useGuildId } from '../hooks.js';
import { useLiveEvent } from '../components/layout.js';
import { api, formatDate, relativeTime } from '../api.js';

interface AuditEntry {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
  createdAt: string;
}

interface AuditResponse {
  entries: AuditEntry[];
  nextCursor: string | null;
}

export function AuditLogsPage(): React.JSX.Element {
  const guildId = useGuildId();
  const live = useLiveEvent();
  const [action, setAction] = useState('');
  const [actorId, setActorId] = useState('');
  const [applied, setApplied] = useState({ action: '', actorId: '' });
  const [cursor, setCursor] = useState<string | null>(null);
  const [extra, setExtra] = useState<AuditEntry[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const query = new URLSearchParams({ limit: '50' });
  if (applied.action.trim() !== '') query.set('action', applied.action.trim());
  if (applied.actorId.trim() !== '') query.set('actorId', applied.actorId.trim());
  if (cursor !== null) query.set('cursor', cursor);

  const state = useFetch<AuditResponse>(`/guilds/${guildId}/audit-logs?${query.toString()}`);

  useEffect(() => {
    setExtra([]);
    setCursor(null);
  }, [applied.action, applied.actorId]);

  useEffect(() => {
    if (live !== null && live.type !== 'ready') {
      void state.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.at]);

  if (state.loading && state.data === null) {
    return <Spinner label="Loading audit trail" />;
  }
  if (state.error !== null) {
    return <ErrorBanner message={state.error} />;
  }

  const firstPage = state.data?.entries ?? [];
  const entries = cursor === null ? firstPage : [...extra, ...firstPage];
  const nextCursor = state.data?.nextCursor ?? null;

  const loadMore = async (): Promise<void> => {
    if (nextCursor === null) {
      return;
    }
    const result = await api.get<AuditResponse>(
      `/guilds/${guildId}/audit-logs?limit=50&cursor=${encodeURIComponent(nextCursor)}`,
    );
    setExtra((current) => [...current, ...firstPage]);
    setCursor(nextCursor);
    state.setData(result);
  };

  return (
    <div>
      <PageHeader
        eyebrow="History"
        title="Audit Logs"
        description="Append-only record of configuration, moderation, security, and dashboard events. Entries are never edited or deleted from the dashboard."
      />

      <Card title="Filters">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Action">
            <TextInput value={action} onChange={setAction} placeholder="e.g. config.updated" />
          </Field>
          <Field label="Actor ID">
            <TextInput value={actorId} onChange={setActorId} placeholder="Discord user ID" />
          </Field>
          <div className="flex items-end">
            <Button variant="primary" onClick={() => setApplied({ action, actorId })}>
              Apply filters
            </Button>
          </div>
        </div>
      </Card>

      <Card
        className="mt-6"
        title="Entries"
        description={`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} loaded.`}
      >
        {entries.length === 0 ? (
          <p className="text-xs text-ash">No audit entries match these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="t77-table w-full min-w-[760px]">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Target</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="whitespace-nowrap text-ash">{formatDate(entry.createdAt)}</td>
                    <td className="font-mono text-[11px]">{entry.action}</td>
                    <td>
                      <p className="text-[10px] uppercase tracking-wide text-ash">
                        {entry.actorType}
                      </p>
                      <p className="font-mono text-[11px]">{entry.actorId ?? 'system'}</p>
                    </td>
                    <td>
                      {entry.targetType === null ? (
                        <span className="text-ash">-</span>
                      ) : (
                        <>
                          <p className="text-[10px] uppercase tracking-wide text-ash">
                            {entry.targetType}
                          </p>
                          <p className="max-w-[220px] truncate font-mono text-[11px]">
                            {entry.targetId ?? '-'}
                          </p>
                        </>
                      )}
                    </td>
                    <td className="text-right">
                      <Button onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}>
                        {expanded === entry.id ? 'Hide' : 'Details'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {expanded !== null && (
          <div className="mt-4 rounded-xl border border-edge bg-[#0d0f13] p-4">
            {(() => {
              const entry = entries.find((item) => item.id === expanded);
              if (entry === undefined) {
                return null;
              }
              return (
                <div className="space-y-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="info">{entry.action}</Badge>
                    <span className="text-ash">{formatDate(entry.createdAt)}</span>
                    {entry.requestId !== null && (
                      <span className="font-mono text-[10px] text-ash">req {entry.requestId}</span>
                    )}
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-ash">Before</p>
                      <pre className="t77-scroll mt-1 max-h-64 overflow-auto rounded-lg border border-edge bg-black/40 p-3 font-mono text-[10px] text-ash">
                        {JSON.stringify(entry.before, null, 2) ?? 'null'}
                      </pre>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-ash">After</p>
                      <pre className="t77-scroll mt-1 max-h-64 overflow-auto rounded-lg border border-edge bg-black/40 p-3 font-mono text-[10px] text-ash">
                        {JSON.stringify(entry.after, null, 2) ?? 'null'}
                      </pre>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {nextCursor !== null && (
          <div className="mt-4">
            <Button onClick={() => void loadMore()}>Load more</Button>
          </div>
        )}
      </Card>
    </div>
  );
}

interface AccessGrant {
  id: string;
  subjectType: 'USER' | 'ROLE';
  subjectId: string;
  permissionKeys: string[];
  grantedBy: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface StaffResponse {
  grants: AccessGrant[];
  logChannels: Array<{ category: string; channelId: string }>;
  catalogue: Array<{ key: string; label: string }>;
  actor: { id: string; owner: boolean };
}

const DURATIONS = ['', '30m', '12h', '7d', '2w'] as const;

export function StaffPage(): React.JSX.Element {
  const guildId = useGuildId();
  const toast = useToast();
  const state = useFetch<StaffResponse>(`/guilds/${guildId}/staff`);
  const live = useLiveEvent();
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<AccessGrant | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    subjectType: 'USER' as 'USER' | 'ROLE',
    subjectId: '',
    duration: '' as string,
    permissions: [] as string[],
  });

  useEffect(() => {
    if (live !== null && live.type !== 'ready') {
      void state.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.at]);

  if (state.loading && state.data === null) {
    return <Spinner label="Loading staff grants" />;
  }
  if (state.error !== null) {
    return <ErrorBanner message={state.error} />;
  }

  const grants = state.data?.grants ?? [];

  const grant = async (): Promise<void> => {
    if (form.permissions.length === 0) {
      toast('Select at least one T77 permission.', 'error');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/guilds/${guildId}/staff`, {
        subjectType: form.subjectType,
        subjectId: form.subjectId.trim(),
        permissionKeys: form.permissions,
        ...(form.duration === '' ? {} : { duration: form.duration }),
      });
      toast('Staff grant created.', 'success');
      setAdding(false);
      setForm({ subjectType: 'USER', subjectId: '', duration: '', permissions: [] });
      await state.reload();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not create grant.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (): Promise<void> => {
    if (revoking === null) {
      return;
    }
    setBusy(true);
    try {
      await api.delete(`/guilds/${guildId}/staff/${revoking.id}`);
      toast('Staff grant revoked.', 'success');
      setRevoking(null);
      await state.reload();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not revoke grant.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const togglePermission = (key: string): void => {
    setForm((current) => ({
      ...current,
      permissions: current.permissions.includes(key)
        ? current.permissions.filter((value) => value !== key)
        : [...current.permissions, key],
    }));
  };

  return (
    <div>
      <PageHeader
        eyebrow="Authorization"
        title="Staff"
        description="T77 staff grants widen which dashboard requests a member may make. They never bypass Discord permissions, role hierarchy, the server owner, or the bot's own permissions."
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            Grant access
          </Button>
        }
      />

      <Card
        title="Granted permissions"
        description="Only USER grants are evaluated by the API. ROLE grants are honored by the bot where it can resolve member roles."
      >
        {grants.length === 0 ? (
          <p className="text-xs text-ash">No staff grants recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="t77-table w-full min-w-[760px]">
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>Permissions</th>
                  <th>Granted by</th>
                  <th>Created</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {grants.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Badge tone={item.subjectType === 'ROLE' ? 'info' : 'neutral'}>
                        {item.subjectType}
                      </Badge>
                      <p className="mt-1 font-mono text-[11px]">{item.subjectId}</p>
                    </td>
                    <td>
                      <div className="flex max-w-[320px] flex-wrap gap-1">
                        {item.permissionKeys.map((key) => (
                          <span
                            key={key}
                            className="rounded border border-edge-strong bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-ash"
                          >
                            {key}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="font-mono text-[11px] text-ash">{item.grantedBy}</td>
                    <td className="text-ash">{formatDate(item.createdAt)}</td>
                    <td className="text-ash">
                      {item.expiresAt === null ? 'Never' : relativeTime(item.expiresAt)}
                    </td>
                    <td className="text-right">
                      <Button variant="danger" onClick={() => setRevoking(item)}>
                        Revoke
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        className="mt-6"
        title="Permission catalogue"
        description="Every key T77 recognises. security.config and staff.manage are the most sensitive."
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {(state.data?.catalogue ?? []).map((entry) => (
            <div key={entry.key} className="rounded-lg border border-edge bg-[#0d0f13] px-3 py-2">
              <p className="font-mono text-[10px] text-blood-soft">{entry.key}</p>
              <p className="mt-0.5 text-xs text-ash">{entry.label}</p>
            </div>
          ))}
        </div>
      </Card>

      <ConfirmDialog
        open={adding}
        title="Grant T77 staff access"
        description="Grants are evaluated after Discord hierarchy checks. Choose only the permissions this member needs."
        confirmLabel="Create grant"
        busy={busy}
        onCancel={() => setAdding(false)}
        onConfirm={() => void grant()}
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Subject type">
              <Select
                value={form.subjectType}
                onChange={(value) => setForm({ ...form, subjectType: value })}
                options={[
                  { value: 'USER', label: 'User' },
                  { value: 'ROLE', label: 'Role' },
                ]}
              />
            </Field>
            <Field label="Subject ID">
              <TextInput
                value={form.subjectId}
                onChange={(value) => setForm({ ...form, subjectId: value })}
                placeholder="123456789012345678"
              />
            </Field>
          </div>
          <Field label="Expiry" hint="Leave empty for a permanent grant.">
            <Select
              value={form.duration}
              onChange={(value) => setForm({ ...form, duration: value })}
              options={DURATIONS.map((value) => ({
                value,
                label: value === '' ? 'Permanent' : value,
              }))}
            />
          </Field>
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-ash">
              Permissions
            </p>
            <div className="t77-scroll grid max-h-56 gap-1 overflow-y-auto rounded-lg border border-edge bg-[#0d0f13] p-2">
              {(state.data?.catalogue ?? []).map((entry) => (
                <label
                  key={entry.key}
                  className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-white/5"
                >
                  <input
                    type="checkbox"
                    checked={form.permissions.includes(entry.key)}
                    onChange={() => togglePermission(entry.key)}
                  />
                  <span className="font-mono text-[10px]">{entry.key}</span>
                  <span className="text-ash">{entry.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={revoking !== null}
        title="Revoke staff grant"
        description="The member loses these T77 permissions immediately. Discord permissions and the audit history are unchanged."
        confirmLabel="Revoke"
        danger
        busy={busy}
        onCancel={() => setRevoking(null)}
        onConfirm={() => void revoke()}
      />
    </div>
  );
}

import { useEffect, useState } from 'react';

import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  PageHeader,
  Select,
  Spinner,
  TextInput,
} from '../components/ui.js';
import { useFetch, useGuildId } from '../hooks.js';
import { useLiveEvent } from '../components/layout.js';
import { api, formatDate } from '../api.js';

interface ModerationCase {
  id: string;
  number: number;
  type: string;
  targetId: string;
  moderatorId: string;
  reason: string;
  durationSeconds: number | null;
  status: string;
  expiresAt: string | null;
  closedAt: string | null;
  source: string;
  createdAt: string;
}

interface CasePage {
  cases: ModerationCase[];
  nextCursor: string | null;
}

interface Warning {
  id: string;
  targetId: string;
  moderatorId: string;
  reason: string;
  active: boolean;
  createdAt: string;
  revokedAt: string | null;
}

interface CaseDetail {
  case: ModerationCase;
  warnings: Warning[];
}

const TYPES = [
  '',
  'BAN',
  'KICK',
  'TIMEOUT',
  'UNTIMEOUT',
  'WARN',
  'UNWARN',
  'UNBAN',
  'PURGE',
  'LOCK',
  'UNLOCK',
] as const;

export function ModerationPage(): React.JSX.Element {
  const guildId = useGuildId();
  const live = useLiveEvent();
  const [type, setType] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [targetId, setTargetId] = useState('');
  const [applied, setApplied] = useState({ type: '', status: '', targetId: '' });
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const query = new URLSearchParams({ limit: '100' });
  if (applied.type !== '') query.set('type', applied.type);
  if (applied.status !== '') query.set('status', applied.status);
  if (applied.targetId.trim() !== '') query.set('targetId', applied.targetId.trim());

  const state = useFetch<CasePage>(`/guilds/${guildId}/moderation/cases?${query.toString()}`);

  useEffect(() => {
    if (live !== null && live.type !== 'ready') {
      void state.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.at]);

  useEffect(() => {
    if (selected === null) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let active = true;
    setDetailError(null);
    void api
      .get<CaseDetail>(`/guilds/${guildId}/moderation/cases/${selected}`)
      .then((value) => {
        if (active) {
          setDetail(value);
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setDetail(null);
          setDetailError(caught instanceof Error ? caught.message : 'Could not load case.');
        }
      });
    return () => {
      active = false;
    };
  }, [guildId, selected]);

  if (state.loading && state.data === null) {
    return <Spinner label="Loading moderation cases" />;
  }
  if (state.error !== null) {
    return <ErrorBanner message={state.error} />;
  }

  const cases = state.data?.cases ?? [];

  return (
    <div>
      <PageHeader
        eyebrow="Enforcement"
        title="Moderation"
        description="Case history recorded by the T77 bot. Read-only in the dashboard: moderation actions are executed through Discord commands so hierarchy and permission checks always run against live member state."
      />

      <Card title="Filters">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Case type">
            <Select
              value={type}
              onChange={setType}
              options={TYPES.map((value) => ({ value, label: value === '' ? 'All types' : value }))}
            />
          </Field>
          <Field label="Status">
            <Select
              value={status}
              onChange={setStatus}
              options={[
                { value: '', label: 'All statuses' },
                { value: 'OPEN', label: 'Open' },
                { value: 'CLOSED', label: 'Closed' },
                { value: 'REVERSED', label: 'Reversed' },
              ]}
            />
          </Field>
          <Field label="Target ID">
            <TextInput value={targetId} onChange={setTargetId} placeholder="Any user" />
          </Field>
          <div className="flex items-end">
            <Button variant="primary" onClick={() => setApplied({ type, status, targetId })}>
              Apply filters
            </Button>
          </div>
        </div>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.3fr_0.7fr]">
        <Card title="Cases" description={`${cases.length} case(s) returned.`}>
          {cases.length === 0 ? (
            <p className="text-xs text-ash">No moderation cases match these filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="t77-table w-full min-w-[620px]">
                <thead>
                  <tr>
                    <th>Case</th>
                    <th>Type</th>
                    <th>Target</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {cases.map((record) => (
                    <tr
                      key={record.id}
                      className={selected === String(record.number) ? 'bg-white/[0.03]' : ''}
                    >
                      <td className="font-mono">#{record.number}</td>
                      <td>{record.type}</td>
                      <td className="font-mono text-[11px]">{record.targetId}</td>
                      <td>
                        <Badge
                          tone={
                            record.status === 'CLOSED'
                              ? 'good'
                              : record.status === 'REVERSED'
                                ? 'warn'
                                : 'info'
                          }
                        >
                          {record.status}
                        </Badge>
                      </td>
                      <td className="text-ash">{formatDate(record.createdAt)}</td>
                      <td className="text-right">
                        <Button onClick={() => setSelected(String(record.number))}>View</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Case detail">
          {selected === null ? (
            <p className="text-xs text-ash">
              Select a case to inspect its reason and warning history.
            </p>
          ) : detailError !== null ? (
            <ErrorBanner message={detailError} />
          ) : detail === null ? (
            <Spinner label="Loading case" />
          ) : (
            <div className="space-y-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-semibold">#{detail.case.number}</span>
                <Badge tone={detail.case.status === 'OPEN' ? 'info' : 'neutral'}>
                  {detail.case.status}
                </Badge>
              </div>
              <dl className="space-y-2">
                <div>
                  <dt className="text-[10px] uppercase tracking-wide text-ash">Type</dt>
                  <dd>{detail.case.type}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-wide text-ash">Target</dt>
                  <dd className="font-mono text-[11px]">{detail.case.targetId}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-wide text-ash">Moderator</dt>
                  <dd className="font-mono text-[11px]">{detail.case.moderatorId}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-wide text-ash">Reason</dt>
                  <dd className="leading-relaxed text-ash">{detail.case.reason}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-wide text-ash">Created</dt>
                  <dd className="text-ash">{formatDate(detail.case.createdAt)}</dd>
                </div>
                {detail.case.durationSeconds !== null && (
                  <div>
                    <dt className="text-[10px] uppercase tracking-wide text-ash">Duration</dt>
                    <dd className="text-ash">{detail.case.durationSeconds} seconds</dd>
                  </div>
                )}
              </dl>

              <div className="border-t border-edge pt-3">
                <p className="text-[10px] uppercase tracking-wide text-ash">
                  Warnings ({detail.warnings.filter((warning) => warning.active).length} active)
                </p>
                {detail.warnings.length === 0 ? (
                  <p className="mt-1 text-ash">No warnings for this member.</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {detail.warnings.map((warning) => (
                      <li
                        key={warning.id}
                        className="rounded-lg border border-edge bg-[#0d0f13] px-3 py-2"
                      >
                        <div className="flex items-center justify-between">
                          <Badge tone={warning.active ? 'warn' : 'neutral'}>
                            {warning.active ? 'Active' : 'Revoked'}
                          </Badge>
                          <span className="text-[10px] text-ash">
                            {formatDate(warning.createdAt)}
                          </span>
                        </div>
                        <p className="mt-1 leading-relaxed text-ash">{warning.reason}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card
        className="mt-6"
        title="Role boundaries"
        description="Why moderation is not triggered from this page."
      >
        <ul className="space-y-2 text-xs leading-relaxed text-ash">
          <li>
            T77 refuses to act on itself, the server owner, or a member whose highest role is at or
            above T77&apos;s highest role.
          </li>
          <li>
            T77 staff grants widen who may request an action; they never bypass Discord hierarchy or
            the bot&apos;s own permissions.
          </li>
          <li>
            Every case is written before the Discord call so a failed action is recorded and
            reversed rather than lost.
          </li>
        </ul>
      </Card>
    </div>
  );
}

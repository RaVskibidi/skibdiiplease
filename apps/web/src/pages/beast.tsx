import { useEffect, useState } from 'react';

import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorBanner,
  Field,
  NumberInput,
  PageHeader,
  Spinner,
  TextInput,
  Toggle,
  useToast,
} from '../components/ui.js';
import { useFetch, useGuildId } from '../hooks.js';
import { useLiveEvent } from '../components/layout.js';
import { api, formatDate } from '../api.js';

interface BeastState {
  enabled: boolean;
  active: boolean;
  score: number;
  threshold: number;
  durationMinutes: number;
  emergencyLockdown: boolean;
  activatedAt: string | null;
  expiresAt: string | null;
  activationReason: string | null;
  activatedBy: string | null;
  deactivatedAt: string | null;
  overrideReason: string | null;
}

interface BeastResponse {
  state: BeastState;
  enabled: boolean;
  owner: boolean;
  incidents: Array<{ id: string; type: string; status: string; openedAt: string; score: number }>;
}

export function BeastModePage(): React.JSX.Element {
  const guildId = useGuildId();
  const toast = useToast();
  const state = useFetch<BeastResponse>(`/guilds/${guildId}/beast-mode`);
  const live = useLiveEvent();
  const [form, setForm] = useState({
    enabled: true,
    threshold: 100,
    durationMinutes: 60,
    emergencyLockdown: false,
  });
  const [saving, setSaving] = useState(false);
  const [override, setOverride] = useState<'activate' | 'calm' | null>(null);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [queueing, setQueueing] = useState(false);

  useEffect(() => {
    if (state.data !== null) {
      setForm({
        enabled: state.data.state.enabled,
        threshold: state.data.state.threshold,
        durationMinutes: state.data.state.durationMinutes,
        emergencyLockdown: state.data.state.emergencyLockdown,
      });
    }
  }, [state.data]);

  useEffect(() => {
    if (live !== null && live.type !== 'ready') {
      void state.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.at]);

  if (state.loading && state.data === null) {
    return <Spinner label="Loading Beast Mode" />;
  }
  if (state.error !== null) {
    return <ErrorBanner message={state.error} />;
  }
  if (state.data === null) {
    return <ErrorBanner message="Beast Mode state is unavailable." />;
  }

  const beast = state.data.state;
  const pct = Math.min(100, Math.round((beast.score / Math.max(1, beast.threshold)) * 100));

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.patch(`/guilds/${guildId}/beast-mode`, form);
      toast('Beast Mode settings saved.', 'success');
      await state.reload();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Save failed.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const submitOverride = async (): Promise<void> => {
    if (override === null) {
      return;
    }
    const expected = override === 'activate' ? 'ACTIVATE' : 'CALM';
    if (confirmation !== expected) {
      toast(`Type ${expected} exactly to confirm.`, 'error');
      return;
    }
    setQueueing(true);
    try {
      await api.post(`/guilds/${guildId}/beast-mode/override`, {
        action: override,
        reason,
        confirmation,
      });
      toast(`Beast Mode ${override} queued for the bot.`, 'success');
      setOverride(null);
      setReason('');
      setConfirmation('');
      await state.reload();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Override failed.', 'error');
    } finally {
      setQueueing(false);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="Emergency"
        title="Beast Mode"
        description="An elevated monitoring state. Activation raises scrutiny; it does not itself punish members. Owner confirmation is required for manual overrides."
        actions={
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving...' : 'Save settings'}
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <Card title="Current state">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Badge tone={beast.active ? 'bad' : 'good'}>
                {beast.active ? 'BEAST MODE ACTIVE' : 'Calm'}
              </Badge>
              <p className="mt-3 font-mono text-4xl font-semibold tabular-nums">
                {beast.score}
                <span className="text-sm text-ash"> / {beast.threshold}</span>
              </p>
              <p className="mt-1 text-xs text-ash">Aggregated risk score since reset.</p>
            </div>
            <div className="text-right text-xs text-ash">
              <p>Activated: {formatDate(beast.activatedAt)}</p>
              <p>Expires: {formatDate(beast.expiresAt)}</p>
              <p>Last calm: {formatDate(beast.deactivatedAt)}</p>
            </div>
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-[#1d2028]">
            <div
              className={`h-full rounded-full transition-all ${beast.active ? 'bg-blood' : 'bg-emerald-500'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          {beast.activationReason !== null && (
            <p className="mt-3 text-xs text-ash">Activation reason: {beast.activationReason}</p>
          )}
          {!state.data.owner && (
            <p className="mt-3 text-[11px] text-ash">
              Manual overrides are restricted to the Discord server owner.
            </p>
          )}
        </Card>

        <Card title="Settings">
          <Toggle
            checked={form.enabled}
            onChange={(value) => setForm({ ...form, enabled: value })}
            label="Beast Mode available"
          />
          <Toggle
            checked={form.emergencyLockdown}
            onChange={(value) => setForm({ ...form, emergencyLockdown: value })}
            label="Emergency lockdown"
            description="Permitted only when the server approval state allows it."
          />
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Score threshold">
              <NumberInput
                value={form.threshold}
                min={1}
                max={10_000}
                onChange={(value) => setForm({ ...form, threshold: value })}
              />
            </Field>
            <Field label="Duration (minutes)">
              <NumberInput
                value={form.durationMinutes}
                min={1}
                max={1_440}
                onChange={(value) => setForm({ ...form, durationMinutes: value })}
              />
            </Field>
          </div>
        </Card>
      </div>

      <Card
        className="mt-6"
        title="Owner override"
        description="The request is queued for the bot; the API never changes Discord state directly."
      >
        <div className="flex flex-wrap gap-2">
          <Button
            variant="danger"
            disabled={!state.data.owner}
            onClick={() => setOverride('activate')}
          >
            Activate now
          </Button>
          <Button disabled={!state.data.owner} onClick={() => setOverride('calm')}>
            Return to calm
          </Button>
        </div>
      </Card>

      <Card
        className="mt-6"
        title="Linked incidents"
        description="Incidents used by the Beast Mode scoring pipeline."
      >
        {state.data.incidents.length === 0 ? (
          <p className="text-xs text-ash">No incidents recorded.</p>
        ) : (
          <ul className="space-y-2">
            {state.data.incidents.map((incident) => (
              <li
                key={incident.id}
                className="flex items-center justify-between rounded-lg border border-edge bg-[#0d0f13] px-3 py-2 text-xs"
              >
                <span className="font-medium">{incident.type}</span>
                <span className="flex items-center gap-3 text-ash">
                  <Badge tone={incident.status === 'OPEN' ? 'bad' : 'neutral'}>
                    {incident.status}
                  </Badge>
                  <span>{formatDate(incident.openedAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={override !== null}
        title={override === 'activate' ? 'Activate Beast Mode' : 'Return Beast Mode to calm'}
        description="This request will be executed by the T77 bot after the queue claims it. Enter a reason and type the confirmation word exactly."
        confirmLabel="Queue override"
        danger={override === 'activate'}
        busy={queueing}
        onCancel={() => setOverride(null)}
        onConfirm={() => void submitOverride()}
      >
        <div className="space-y-3">
          <Field label="Reason">
            <TextInput value={reason} onChange={setReason} placeholder="Describe the incident" />
          </Field>
          <Field label={`Type ${override === 'activate' ? 'ACTIVATE' : 'CALM'} to confirm`}>
            <TextInput
              value={confirmation}
              onChange={setConfirmation}
              placeholder={override === 'activate' ? 'ACTIVATE' : 'CALM'}
            />
          </Field>
        </div>
      </ConfirmDialog>
    </div>
  );
}

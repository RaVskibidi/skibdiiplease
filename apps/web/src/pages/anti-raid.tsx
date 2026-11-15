import { useEffect, useState } from 'react';

import {
  Badge,
  Button,
  Card,
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

interface AntiRaidConfig {
  enabled: boolean;
  joinWindowSeconds: number;
  aggregateThreshold: number;
  minimumSignals: number;
  minimumAccountAgeDays: number;
  riskThreshold: number;
  quarantineRoleId: string | null;
  quarantineEnabled: boolean;
  lockdownEnabled: boolean;
  autoBanEnabled: boolean;
  verificationRequired: boolean;
  bypassBadges: string[];
  velocityWeight: number;
  accountAgeWeight: number;
  avatarWeight: number;
  similarAgeWeight: number;
  suspiciousNameWeight: number;
}

interface AntiRaidResponse {
  config: AntiRaidConfig;
  automationMode: string;
  approvedAt: string | null;
  quarantined: Array<{ id: string; userId: string; createdAt: string; releasedAt: string | null }>;
}

export function AntiRaidPage(): React.JSX.Element {
  const guildId = useGuildId();
  const toast = useToast();
  const state = useFetch<AntiRaidResponse>(`/guilds/${guildId}/anti-raid`);
  const live = useLiveEvent();
  const [form, setForm] = useState<AntiRaidConfig | null>(null);
  const [badges, setBadges] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (state.data !== null) {
      setForm(state.data.config);
      setBadges(state.data.config.bypassBadges.join(', '));
    }
  }, [state.data]);

  useEffect(() => {
    if (live !== null && live.type !== 'ready') {
      void state.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.at]);

  if (state.loading && state.data === null) {
    return <Spinner label="Loading Anti-Raid policy" />;
  }
  if (state.error !== null) {
    return <ErrorBanner message={state.error} />;
  }
  if (form === null) {
    return <ErrorBanner message="Anti-Raid configuration is unavailable." />;
  }

  const patch = <K extends keyof AntiRaidConfig>(key: K, value: AntiRaidConfig[K]): void => {
    setForm((current) => (current === null ? current : { ...current, [key]: value }));
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const payload = {
        ...form,
        quarantineRoleId: form.quarantineRoleId?.trim() === '' ? null : form.quarantineRoleId,
        bypassBadges: badges
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      };
      await api.patch(`/guilds/${guildId}/anti-raid`, payload);
      toast('Anti-Raid policy saved.', 'success');
      await state.reload();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Save failed.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="Protection"
        title="Anti-Raid"
        description="Score join bursts using velocity, account age, avatar presence, and name similarity. Quarantine and lockdown stay gated by automation approval."
        actions={
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving...' : 'Save policy'}
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Detection" description="Thresholds are evaluated over the join window.">
          <Toggle
            checked={form.enabled}
            onChange={(value) => patch('enabled', value)}
            label="Anti-Raid enabled"
          />
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Join window (seconds)">
              <NumberInput
                value={form.joinWindowSeconds}
                min={10}
                max={3_600}
                onChange={(value) => patch('joinWindowSeconds', value)}
              />
            </Field>
            <Field label="Aggregate threshold">
              <NumberInput
                value={form.aggregateThreshold}
                min={2}
                max={10_000}
                onChange={(value) => patch('aggregateThreshold', value)}
              />
            </Field>
            <Field label="Minimum signals">
              <NumberInput
                value={form.minimumSignals}
                min={1}
                max={5}
                onChange={(value) => patch('minimumSignals', value)}
              />
            </Field>
            <Field label="Minimum account age (days)">
              <NumberInput
                value={form.minimumAccountAgeDays}
                min={0}
                max={365}
                onChange={(value) => patch('minimumAccountAgeDays', value)}
              />
            </Field>
            <Field label="Risk threshold (1-100)">
              <NumberInput
                value={form.riskThreshold}
                min={1}
                max={100}
                onChange={(value) => patch('riskThreshold', value)}
              />
            </Field>
            <Field
              label="Quarantine role ID"
              hint="Leave empty to disable quarantine role assignment."
            >
              <TextInput
                value={form.quarantineRoleId ?? ''}
                onChange={(value) => patch('quarantineRoleId', value)}
                placeholder="123456789012345678"
              />
            </Field>
          </div>
        </Card>

        <Card
          title="Containment"
          description="These options never bypass the server's automation approval."
        >
          <Toggle
            checked={form.quarantineEnabled}
            onChange={(value) => patch('quarantineEnabled', value)}
            label="Quarantine suspicious joins"
          />
          <Toggle
            checked={form.lockdownEnabled}
            onChange={(value) => patch('lockdownEnabled', value)}
            label="Allow raid lockdown"
          />
          <Toggle
            checked={form.autoBanEnabled}
            onChange={(value) => patch('autoBanEnabled', value)}
            label="Allow automatic bans"
            description="Destructive and still subject to owner approval."
          />
          <Toggle
            checked={form.verificationRequired}
            onChange={(value) => patch('verificationRequired', value)}
            label="Require verification for new joins"
          />
          <div className="mt-4">
            <Field
              label="Bypass badges"
              hint="Comma-separated Discord badge names, e.g. STAFF, PARTNER."
            >
              <TextInput value={badges} onChange={setBadges} placeholder="STAFF, PARTNER" />
            </Field>
          </div>
        </Card>
      </div>

      <Card
        className="mt-6"
        title="Risk weights"
        description="Weights tune each signal's contribution to the raid score."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {(
            [
              ['velocityWeight', 'Velocity'],
              ['accountAgeWeight', 'Account age'],
              ['avatarWeight', 'No avatar'],
              ['similarAgeWeight', 'Similar age'],
              ['suspiciousNameWeight', 'Name pattern'],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label}>
              <NumberInput
                value={form[key]}
                min={0}
                max={100}
                onChange={(value) => patch(key, value)}
              />
            </Field>
          ))}
        </div>
      </Card>

      <Card
        className="mt-6"
        title="Quarantined members"
        description="Active quarantine entries recorded by the bot."
      >
        {state.data?.quarantined.length === 0 ? (
          <p className="text-xs text-ash">No members are quarantined.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="t77-table w-full">
              <thead>
                <tr>
                  <th>User ID</th>
                  <th>Status</th>
                  <th>Since</th>
                  <th>Released</th>
                </tr>
              </thead>
              <tbody>
                {state.data?.quarantined.map((entry) => (
                  <tr key={entry.id}>
                    <td className="font-mono text-[11px]">{entry.userId}</td>
                    <td>
                      <Badge tone={entry.releasedAt === null ? 'warn' : 'good'}>
                        {entry.releasedAt === null ? 'Quarantined' : 'Released'}
                      </Badge>
                    </td>
                    <td className="text-ash">{formatDate(entry.createdAt)}</td>
                    <td className="text-ash">{formatDate(entry.releasedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-[11px] text-ash">
          Automation mode: {state.data?.automationMode ?? 'OBSERVE'} · Approved{' '}
          {state.data?.approvedAt === null || state.data?.approvedAt === undefined
            ? 'never'
            : formatDate(state.data.approvedAt)}
        </p>
      </Card>
    </div>
  );
}

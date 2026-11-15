import { useEffect, useState } from 'react';

import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  NumberInput,
  PageHeader,
  Select,
  Spinner,
  TextInput,
  Toggle,
  useToast,
} from '../components/ui.js';
import { useFetch, useGuildId } from '../hooks.js';
import { useLiveEvent } from '../components/layout.js';
import { api, formatDate } from '../api.js';

interface VerificationConfig {
  enabled: boolean;
  mode: 'BUTTON' | 'CAPTCHA';
  buttonFallbackEnabled: boolean;
  unverifiedRoleId: string | null;
  verifiedRoleId: string | null;
  channelId: string | null;
  challengeLength: number;
  timeoutSeconds: number;
  maxAttempts: number;
  captchaNoise: number;
  releaseQuarantineOnPass: boolean;
}

interface Challenge {
  id: string;
  userId: string;
  mode: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
  failureReason: string | null;
}

interface VerificationResponse {
  config: VerificationConfig;
  challenges: Challenge[];
  counts: { pending: number; passed: number; expired: number };
}

const MODES: Array<{ value: VerificationConfig['mode']; label: string }> = [
  { value: 'BUTTON', label: 'Button' },
  { value: 'CAPTCHA', label: 'Captcha' },
];

export function VerificationPage(): React.JSX.Element {
  const guildId = useGuildId();
  const toast = useToast();
  const state = useFetch<VerificationResponse>(`/guilds/${guildId}/verification`);
  const live = useLiveEvent();
  const [form, setForm] = useState<VerificationConfig | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (state.data !== null) {
      setForm(state.data.config);
    }
  }, [state.data]);

  useEffect(() => {
    if (live !== null && live.type !== 'ready') {
      void state.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.at]);

  if (state.loading && state.data === null) {
    return <Spinner label="Loading verification policy" />;
  }
  if (state.error !== null) {
    return <ErrorBanner message={state.error} />;
  }
  if (form === null || state.data === null) {
    return <ErrorBanner message="Verification configuration is unavailable." />;
  }

  const patch = <K extends keyof VerificationConfig>(
    key: K,
    value: VerificationConfig[K],
  ): void => {
    setForm((current) => (current === null ? current : { ...current, [key]: value }));
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.patch(`/guilds/${guildId}/verification`, {
        ...form,
        unverifiedRoleId: form.unverifiedRoleId?.trim() === '' ? null : form.unverifiedRoleId,
        verifiedRoleId: form.verifiedRoleId?.trim() === '' ? null : form.verifiedRoleId,
        channelId: form.channelId?.trim() === '' ? null : form.channelId,
      });
      toast('Verification policy saved.', 'success');
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
        eyebrow="Gatekeeping"
        title="Verification"
        description="New members complete a challenge before receiving the verified role. Challenges are issued and scored by the bot; this page stores the policy and shows recorded attempts."
        actions={
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving...' : 'Save policy'}
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card title="Pending">
          <p className="text-2xl font-semibold tabular-nums">{state.data.counts.pending}</p>
        </Card>
        <Card title="Passed">
          <p className="text-2xl font-semibold tabular-nums text-emerald-300">
            {state.data.counts.passed}
          </p>
        </Card>
        <Card title="Expired">
          <p className="text-2xl font-semibold tabular-nums text-amber-300">
            {state.data.counts.expired}
          </p>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Policy">
          <Toggle
            checked={form.enabled}
            onChange={(value) => patch('enabled', value)}
            label="Verification enabled"
          />
          <div className="mt-3 grid gap-4">
            <Field label="Challenge mode">
              <Select
                value={form.mode}
                onChange={(value) => patch('mode', value)}
                options={MODES}
              />
            </Field>
            <Field
              label="Verification channel ID"
              hint="The channel where the challenge is posted, if T77 should create it."
            >
              <TextInput
                value={form.channelId ?? ''}
                onChange={(value) => patch('channelId', value)}
                placeholder="123456789012345678"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Unverified role ID">
                <TextInput
                  value={form.unverifiedRoleId ?? ''}
                  onChange={(value) => patch('unverifiedRoleId', value)}
                  placeholder="123456789012345678"
                />
              </Field>
              <Field label="Verified role ID">
                <TextInput
                  value={form.verifiedRoleId ?? ''}
                  onChange={(value) => patch('verifiedRoleId', value)}
                  placeholder="123456789012345678"
                />
              </Field>
            </div>
          </div>
        </Card>

        <Card title="Challenge rules">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Challenge length">
              <NumberInput
                value={form.challengeLength}
                min={4}
                max={10}
                onChange={(value) => patch('challengeLength', value)}
              />
            </Field>
            <Field label="Timeout (seconds)">
              <NumberInput
                value={form.timeoutSeconds}
                min={60}
                max={3_600}
                onChange={(value) => patch('timeoutSeconds', value)}
              />
            </Field>
            <Field label="Maximum attempts">
              <NumberInput
                value={form.maxAttempts}
                min={1}
                max={10}
                onChange={(value) => patch('maxAttempts', value)}
              />
            </Field>
            <Field label="Captcha noise">
              <NumberInput
                value={form.captchaNoise}
                min={0}
                max={12}
                onChange={(value) => patch('captchaNoise', value)}
              />
            </Field>
          </div>
          <div className="mt-2">
            <Toggle
              checked={form.buttonFallbackEnabled}
              onChange={(value) => patch('buttonFallbackEnabled', value)}
              label="Button fallback"
              description="Allow a click challenge when captcha rendering is unavailable."
            />
            <Toggle
              checked={form.releaseQuarantineOnPass}
              onChange={(value) => patch('releaseQuarantineOnPass', value)}
              label="Release quarantine on pass"
              description="Removes the quarantine role after a successful challenge."
            />
          </div>
        </Card>
      </div>

      <Card
        className="mt-6"
        title="Recent challenges"
        description="Stored challenge records. Answer hashes are never sent to the browser."
      >
        {state.data.challenges.length === 0 ? (
          <p className="text-xs text-ash">No challenges recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="t77-table w-full min-w-[700px]">
              <thead>
                <tr>
                  <th>User ID</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Issued</th>
                  <th>Expires</th>
                </tr>
              </thead>
              <tbody>
                {state.data.challenges.map((challenge) => (
                  <tr key={challenge.id}>
                    <td className="font-mono text-[11px]">{challenge.userId}</td>
                    <td>{challenge.mode}</td>
                    <td>
                      <Badge
                        tone={
                          challenge.status === 'PASSED'
                            ? 'good'
                            : challenge.status === 'FAILED'
                              ? 'bad'
                              : challenge.status === 'PENDING'
                                ? 'warn'
                                : 'neutral'
                        }
                      >
                        {challenge.status}
                      </Badge>
                    </td>
                    <td className="font-mono">
                      {challenge.attempts}/{challenge.maxAttempts}
                    </td>
                    <td className="text-ash">{formatDate(challenge.createdAt)}</td>
                    <td className="text-ash">{formatDate(challenge.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

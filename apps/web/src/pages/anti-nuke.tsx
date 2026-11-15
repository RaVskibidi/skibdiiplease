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
  Select,
  Spinner,
  Toggle,
  useToast,
} from '../components/ui.js';
import { useFetch, useGuildId } from '../hooks.js';
import { useLiveEvent } from '../components/layout.js';
import { api, formatDate } from '../api.js';
import { useAuth } from '../auth.js';

interface Rule {
  action: string;
  enabled: boolean;
  threshold: number;
  windowSeconds: number;
  containment: string;
  requiresDestructiveApproval: boolean;
  cooldownSeconds: number;
}

interface AntiNukeResponse {
  enabled: boolean;
  automationMode: string;
  approvedAt: string | null;
  rules: Rule[];
  punishments: Array<{ id: string; type: string; status: string; createdAt: string }>;
}

const CONTAINMENT = ['ALERT', 'QUARANTINE', 'ROLE_REMOVAL', 'TIMEOUT', 'KICK', 'BAN'] as const;

export function AntiNukePage(): React.JSX.Element {
  const guildId = useGuildId();
  const { session } = useAuth();
  const toast = useToast();
  const state = useFetch<AntiNukeResponse>(`/guilds/${guildId}/anti-nuke`);
  const live = useLiveEvent();
  const [enabled, setEnabled] = useState(false);
  const [rules, setRules] = useState<Rule[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmApproval, setConfirmApproval] = useState(false);
  const [mode, setMode] = useState<'ENFORCE_REVERSIBLE' | 'ENFORCE_DESTRUCTIVE'>(
    'ENFORCE_REVERSIBLE',
  );

  useEffect(() => {
    if (state.data !== null) {
      setEnabled(state.data.enabled);
      setRules(state.data.rules);
    }
  }, [state.data]);

  useEffect(() => {
    if (live !== null && live.type !== 'ready') {
      void state.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.at]);

  if (state.loading && state.data === null) {
    return <Spinner label="Loading Anti-Nuke policy" />;
  }
  if (state.error !== null) {
    return <ErrorBanner message={state.error} />;
  }

  const isOwner = session?.guilds.find((guild) => guild.id === guildId)?.owner ?? false;

  const updateRule = (action: string, changes: Partial<Rule>): void => {
    setRules((current) =>
      current.map((rule) => (rule.action === action ? { ...rule, ...changes } : rule)),
    );
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.patch(`/guilds/${guildId}/anti-nuke`, {
        enabled,
        rules: rules.map((rule) => ({
          action: rule.action,
          enabled: rule.enabled,
          threshold: rule.threshold,
          windowSeconds: rule.windowSeconds,
          containment: rule.containment,
          requiresDestructiveApproval: rule.requiresDestructiveApproval,
          cooldownSeconds: rule.cooldownSeconds,
        })),
      });
      toast('Anti-Nuke policy saved.', 'success');
      await state.reload();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Save failed.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const approve = async (): Promise<void> => {
    try {
      await api.post(`/guilds/${guildId}/anti-nuke/approval`, {
        mode,
        policyVersion: 'dashboard-1',
        confirm: true,
      });
      toast('Enforcement approval recorded.', 'success');
      setConfirmApproval(false);
      await state.reload();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Approval failed.', 'error');
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="Protection"
        title="Anti-Nuke"
        description="Detect destructive staff actions inside a rolling window. Containment is still constrained by T77's hierarchy checks and the server's approval state."
        actions={
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving...' : 'Save policy'}
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1.4fr_0.6fr]">
        <Card
          title="Master switch"
          description="Disabling Anti-Nuke stops detections; it does not erase rule history."
        >
          <Toggle
            checked={enabled}
            onChange={setEnabled}
            label="Anti-Nuke detections"
            description="When enabled, T77 evaluates privileged actions against the rules below."
          />
        </Card>

        <Card
          title="Enforcement approval"
          description="Only the Discord server owner can approve non-observation automation."
        >
          <p className="text-xs text-ash">Current mode</p>
          <p className="mt-1 text-sm font-semibold">{state.data?.automationMode ?? 'OBSERVE'}</p>
          <p className="mt-3 text-xs text-ash">
            {state.data?.approvedAt === null
              ? 'No owner approval recorded. T77 remains in observation mode.'
              : `Approved ${formatDate(state.data?.approvedAt)}`}
          </p>
          <div className="mt-4 space-y-3">
            <Field label="Approval mode">
              <Select
                value={mode}
                onChange={(value) => setMode(value as 'ENFORCE_REVERSIBLE' | 'ENFORCE_DESTRUCTIVE')}
                options={[
                  { value: 'ENFORCE_REVERSIBLE', label: 'Enforce reversible actions' },
                  { value: 'ENFORCE_DESTRUCTIVE', label: 'Enforce destructive actions' },
                ]}
                disabled={!isOwner}
              />
            </Field>
            <Button variant="danger" disabled={!isOwner} onClick={() => setConfirmApproval(true)}>
              Record owner approval
            </Button>
            {!isOwner && (
              <p className="text-[11px] text-ash">Only the server owner can approve enforcement.</p>
            )}
          </div>
        </Card>
      </div>

      <Card
        className="mt-6"
        title="Rules"
        description="Thresholds define how many matching actions inside the window trigger containment."
      >
        <div className="overflow-x-auto">
          <table className="t77-table w-full min-w-[760px]">
            <thead>
              <tr>
                <th>Action</th>
                <th>Enabled</th>
                <th>Threshold</th>
                <th>Window (s)</th>
                <th>Containment</th>
                <th>Cooldown (s)</th>
                <th>Destructive approval</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.action}>
                  <td className="font-mono text-[11px]">{rule.action}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      aria-label={`${rule.action} enabled`}
                      onChange={(event) =>
                        updateRule(rule.action, { enabled: event.target.checked })
                      }
                    />
                  </td>
                  <td className="w-24">
                    <NumberInput
                      value={rule.threshold}
                      min={1}
                      max={10_000}
                      onChange={(value) => updateRule(rule.action, { threshold: value })}
                    />
                  </td>
                  <td className="w-28">
                    <NumberInput
                      value={rule.windowSeconds}
                      min={1}
                      max={86_400}
                      onChange={(value) => updateRule(rule.action, { windowSeconds: value })}
                    />
                  </td>
                  <td className="w-44">
                    <Select
                      value={rule.containment}
                      onChange={(value) => updateRule(rule.action, { containment: value })}
                      options={CONTAINMENT.map((value) => ({ value, label: value }))}
                    />
                  </td>
                  <td className="w-24">
                    <NumberInput
                      value={rule.cooldownSeconds}
                      min={0}
                      max={86_400}
                      onChange={(value) => updateRule(rule.action, { cooldownSeconds: value })}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={rule.requiresDestructiveApproval}
                      aria-label={`${rule.action} destructive approval`}
                      onChange={(event) =>
                        updateRule(rule.action, {
                          requiresDestructiveApproval: event.target.checked,
                        })
                      }
                    />
                  </td>
                </tr>
              ))}
              {rules.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-xs text-ash">
                    No rules have been seeded for this server. Use /t77 setup or /t77 antinuke in
                    Discord, then reload.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        className="mt-6"
        title="Recent containment proposals"
        description="Punishments proposed by the security engine."
      >
        {(state.data?.punishments.length ?? 0) === 0 ? (
          <p className="text-xs text-ash">No punishments recorded.</p>
        ) : (
          <ul className="space-y-2">
            {state.data?.punishments.map((punishment) => (
              <li
                key={punishment.id}
                className="flex items-center justify-between rounded-lg border border-edge bg-[#0d0f13] px-3 py-2"
              >
                <span className="text-xs font-medium">{punishment.type}</span>
                <span className="flex items-center gap-3 text-[11px] text-ash">
                  <Badge
                    tone={
                      punishment.status === 'APPLIED'
                        ? 'good'
                        : punishment.status === 'FAILED'
                          ? 'bad'
                          : 'neutral'
                    }
                  >
                    {punishment.status}
                  </Badge>
                  {formatDate(punishment.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={confirmApproval}
        title="Approve enforcement"
        description="This records your owner approval for T77 automation. Reversible enforcement may quarantine, remove roles, or time out members. Destructive enforcement may ban or kick. Hierarchy and bot permission checks still apply."
        confirmLabel="Approve"
        danger
        onCancel={() => setConfirmApproval(false)}
        onConfirm={() => void approve()}
      />
    </div>
  );
}

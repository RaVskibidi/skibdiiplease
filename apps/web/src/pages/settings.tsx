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
  TextInput,
  Toggle,
  useToast,
} from '../components/ui.js';
import { useFetch, useGuildId } from '../hooks.js';
import { useLiveEvent } from '../components/layout.js';
import { api, formatDate } from '../api.js';
import { useAuth } from '../auth.js';

interface GuildConfig {
  version: number;
  locale: string;
  timezone: string;
  automationMode: 'OBSERVE' | 'ENFORCE_REVERSIBLE' | 'ENFORCE_DESTRUCTIVE';
  antiNukeEnabled: boolean;
  antiRaidEnabled: boolean;
  beastModeEnabled: boolean;
  automodEnabled: boolean;
  verificationEnabled: boolean;
  botProtectionEnabled: boolean;
  loggingEnabled: boolean;
  backupsEnabled: boolean;
  backupIntervalHours: number;
  backupRetentionDays: number;
  enforcementApprovedAt: string | null;
  enforcementApprovedBy: string | null;
  lastScheduledBackupAt: string | null;
}

interface SettingsResponse {
  config: GuildConfig;
  logChannels: Array<{ category: string; channelId: string }>;
}

export function SettingsPage(): React.JSX.Element {
  const guildId = useGuildId();
  const { session } = useAuth();
  const toast = useToast();
  const state = useFetch<SettingsResponse>(`/guilds/${guildId}/settings`);
  const live = useLiveEvent();
  const [form, setForm] = useState<GuildConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmEnforcement, setConfirmEnforcement] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetText, setResetText] = useState('');

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
    return <Spinner label="Loading settings" />;
  }
  if (state.error !== null) {
    return <ErrorBanner message={state.error} />;
  }
  if (form === null) {
    return <ErrorBanner message="Settings are unavailable." />;
  }

  const isOwner = session?.guilds.find((guild) => guild.id === guildId)?.owner ?? false;

  const patch = <K extends keyof GuildConfig>(key: K, value: GuildConfig[K]): void => {
    setForm((current) => (current === null ? current : { ...current, [key]: value }));
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const payload = {
        expectedVersion: form.version,
        locale: form.locale,
        timezone: form.timezone,
        automationMode: form.automationMode,
        antiNukeEnabled: form.antiNukeEnabled,
        antiRaidEnabled: form.antiRaidEnabled,
        beastModeEnabled: form.beastModeEnabled,
        automodEnabled: form.automodEnabled,
        verificationEnabled: form.verificationEnabled,
        botProtectionEnabled: form.botProtectionEnabled,
        loggingEnabled: form.loggingEnabled,
        backupsEnabled: form.backupsEnabled,
        backupIntervalHours: form.backupIntervalHours,
        backupRetentionDays: form.backupRetentionDays,
      };
      await api.patch(`/guilds/${guildId}/config`, {
        ...payload,
        ...(form.automationMode === 'OBSERVE' ? {} : { confirm: true }),
      });
      toast('Settings saved.', 'success');
      await state.reload();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Save failed.', 'error');
      await state.reload().catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };

  const reset = async (): Promise<void> => {
    if (resetText.trim() !== 'RESET') {
      toast('Type RESET exactly to confirm.', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.post(`/guilds/${guildId}/config/reset`, { confirm: true });
      toast('Configuration reset to defaults.', 'success');
      setConfirmReset(false);
      setResetText('');
      await state.reload();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Reset failed.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const revokeEnforcement = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.post(`/guilds/${guildId}/config/revoke-enforcement`, {
        reason: 'Enforcement approval revoked from the dashboard.',
      });
      toast('Enforcement approval revoked. T77 returned to observation mode.', 'success');
      await state.reload();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not revoke approval.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="Configuration"
        title="Settings"
        description="General server configuration, module defaults, backup schedule, and enforcement approval. Saving a non-observation automation mode requires the server owner."
        actions={
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving...' : 'Save settings'}
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="General">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Locale" hint="BCP-47 tag such as en or en-US.">
              <TextInput value={form.locale} onChange={(value) => patch('locale', value)} />
            </Field>
            <Field label="Timezone" hint="IANA timezone, e.g. Europe/London.">
              <TextInput value={form.timezone} onChange={(value) => patch('timezone', value)} />
            </Field>
          </div>
          <div className="mt-2">
            <Toggle
              checked={form.loggingEnabled}
              onChange={(value) => patch('loggingEnabled', value)}
              label="Security logging"
            />
          </div>
          <div className="mt-4">
            <p className="text-[10px] uppercase tracking-wide text-ash">Configured log channels</p>
            {(state.data?.logChannels.length ?? 0) === 0 ? (
              <p className="mt-1 text-xs text-ash">
                None configured. Use /t77 logs in Discord to route security events.
              </p>
            ) : (
              <ul className="mt-2 space-y-1 font-mono text-[11px] text-ash">
                {state.data?.logChannels.map((channel) => (
                  <li key={`${channel.category}:${channel.channelId}`}>
                    {channel.category} → {channel.channelId}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card
          title="Automation mode"
          description="Observation records incidents without acting. Reversible containment includes quarantine, role removal, and timeouts."
        >
          <Select
            value={form.automationMode}
            onChange={(value) => patch('automationMode', value)}
            options={[
              { value: 'OBSERVE', label: 'Observe only' },
              { value: 'ENFORCE_REVERSIBLE', label: 'Enforce reversible actions' },
              { value: 'ENFORCE_DESTRUCTIVE', label: 'Enforce destructive actions' },
            ]}
            disabled={!isOwner}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge tone={form.enforcementApprovedAt === null ? 'warn' : 'good'}>
              {form.enforcementApprovedAt === null ? 'Not approved' : 'Approved'}
            </Badge>
            {form.enforcementApprovedAt !== null && (
              <span className="text-[11px] text-ash">{formatDate(form.enforcementApprovedAt)}</span>
            )}
          </div>
          {form.automationMode !== 'OBSERVE' && (
            <Button
              variant="danger"
              className="mt-3"
              disabled={!isOwner || saving}
              onClick={() => setConfirmEnforcement(true)}
            >
              Approve current mode
            </Button>
          )}
          {form.enforcementApprovedAt !== null && (
            <Button className="mt-3" disabled={saving} onClick={() => void revokeEnforcement()}>
              Revoke approval
            </Button>
          )}
          {!isOwner && (
            <p className="mt-3 text-[11px] text-ash">
              Only the Discord server owner can change enforcement. Staff grants cannot approve
              destructive automation.
            </p>
          )}
        </Card>
      </div>

      <Card
        className="mt-6"
        title="Modules"
        description="These switches mirror the individual module pages and are read by the bot at event time."
      >
        <div className="grid gap-1 sm:grid-cols-2">
          <Toggle
            checked={form.antiNukeEnabled}
            onChange={(value) => patch('antiNukeEnabled', value)}
            label="Anti-Nuke"
          />
          <Toggle
            checked={form.antiRaidEnabled}
            onChange={(value) => patch('antiRaidEnabled', value)}
            label="Anti-Raid"
          />
          <Toggle
            checked={form.beastModeEnabled}
            onChange={(value) => patch('beastModeEnabled', value)}
            label="Beast Mode"
          />
          <Toggle
            checked={form.automodEnabled}
            onChange={(value) => patch('automodEnabled', value)}
            label="AutoMod"
          />
          <Toggle
            checked={form.verificationEnabled}
            onChange={(value) => patch('verificationEnabled', value)}
            label="Verification"
          />
          <Toggle
            checked={form.botProtectionEnabled}
            onChange={(value) => patch('botProtectionEnabled', value)}
            label="Bot Protection"
          />
          <Toggle
            checked={form.backupsEnabled}
            onChange={(value) => patch('backupsEnabled', value)}
            label="Scheduled backups"
          />
        </div>
      </Card>

      <Card
        className="mt-6"
        title="Backup schedule"
        description="The worker requests due backups over Redis; the bot performs the capture. Last scheduled run is recorded below."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Interval (hours)">
            <NumberInput
              value={form.backupIntervalHours}
              min={1}
              max={720}
              onChange={(value) => patch('backupIntervalHours', value)}
            />
          </Field>
          <Field label="Retention (days)">
            <NumberInput
              value={form.backupRetentionDays}
              min={1}
              max={3_650}
              onChange={(value) => patch('backupRetentionDays', value)}
            />
          </Field>
          <Field label="Last scheduled backup">
            <p className="rounded-lg border border-edge-strong bg-[#0c0e12] px-3 py-2 text-sm text-ash">
              {formatDate(form.lastScheduledBackupAt)}
            </p>
          </Field>
        </div>
      </Card>

      <Card
        className="mt-6"
        title="Danger zone"
        description="Resetting restores the default observation-first configuration. Audit history and moderation records are kept."
      >
        <Button variant="danger" disabled={saving} onClick={() => setConfirmReset(true)}>
          Reset configuration
        </Button>
      </Card>

      <ConfirmDialog
        open={confirmEnforcement}
        title="Approve enforcement mode"
        description="You are recording owner approval for T77 automation. Hierarchy, owner immunity, and bot permission checks still gate every action. This is audit-logged."
        confirmLabel="Record approval"
        danger
        busy={saving}
        onCancel={() => setConfirmEnforcement(false)}
        onConfirm={() => {
          setConfirmEnforcement(false);
          void save();
        }}
      />

      <ConfirmDialog
        open={confirmReset}
        title="Reset configuration"
        description="All configuration fields return to T77 defaults. T77 returns to observation mode. Type RESET to continue."
        confirmLabel="Reset configuration"
        danger
        busy={saving}
        onCancel={() => {
          setConfirmReset(false);
          setResetText('');
        }}
        onConfirm={() => void reset()}
      >
        <Field label="Confirmation">
          <TextInput value={resetText} onChange={setResetText} placeholder="RESET" />
        </Field>
      </ConfirmDialog>
    </div>
  );
}

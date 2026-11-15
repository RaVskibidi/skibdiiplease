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

interface WhitelistEntry {
  id: string;
  targetType: 'USER' | 'ROLE' | 'CHANNEL';
  targetId: string;
  scope: 'GLOBAL' | 'ACTION';
  action: string | null;
  reason: string;
  createdBy: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface WhitelistResponse {
  entries: WhitelistEntry[];
  includeRevoked: boolean;
}

const ACTIONS = [
  'MEMBER_BAN',
  'MEMBER_KICK',
  'MEMBER_PRUNE',
  'MEMBER_ROLE_UPDATE',
  'CHANNEL_CREATE',
  'CHANNEL_DELETE',
  'CHANNEL_UPDATE',
  'CHANNEL_PERMISSION_UPDATE',
  'ROLE_CREATE',
  'ROLE_DELETE',
  'ROLE_UPDATE',
  'ROLE_PERMISSION_UPDATE',
  'ADMINISTRATOR_GRANT',
  'DANGEROUS_ROLE_ASSIGN',
  'MASS_ROLE_ASSIGN',
  'BOT_ADD',
  'WEBHOOK_CREATE',
  'WEBHOOK_UPDATE',
  'WEBHOOK_DELETE',
  'GUILD_UPDATE',
  'VANITY_URL_UPDATE',
  'INVITE_DELETE',
  'EMOJI_UPDATE',
  'STICKER_UPDATE',
  'INTEGRATION_CREATE',
  'INTEGRATION_UPDATE',
  'INTEGRATION_DELETE',
] as const;

const DURATIONS = ['', '30m', '12h', '7d', '2w'] as const;

export function WhitelistPage(): React.JSX.Element {
  const guildId = useGuildId();
  const toast = useToast();
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const state = useFetch<WhitelistResponse>(
    `/guilds/${guildId}/whitelist?includeRevoked=${String(includeRevoked)}`,
  );
  const live = useLiveEvent();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<WhitelistEntry | null>(null);
  const [form, setForm] = useState({
    targetType: 'USER' as WhitelistEntry['targetType'],
    targetId: '',
    scope: 'GLOBAL' as WhitelistEntry['scope'],
    action: '' as string,
    reason: '',
    duration: '' as string,
  });

  useEffect(() => {
    if (live !== null && live.type !== 'ready') {
      void state.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.at]);

  if (state.loading && state.data === null) {
    return <Spinner label="Loading whitelist" />;
  }
  if (state.error !== null) {
    return <ErrorBanner message={state.error} />;
  }

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.post(`/guilds/${guildId}/whitelist`, {
        targetType: form.targetType,
        targetId: form.targetId.trim(),
        scope: form.scope,
        action: form.scope === 'ACTION' ? form.action : null,
        reason: form.reason.trim(),
        ...(form.duration === '' ? {} : { duration: form.duration }),
      });
      toast('Whitelist entry created.', 'success');
      setCreating(false);
      setForm({
        targetType: 'USER',
        targetId: '',
        scope: 'GLOBAL',
        action: '',
        reason: '',
        duration: '',
      });
      await state.reload();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not create entry.', 'error');
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
      await api.delete(`/guilds/${guildId}/whitelist/${revoking.id}`);
      toast('Whitelist entry revoked.', 'success');
      setRevoking(null);
      await state.reload();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not revoke entry.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const entries = state.data?.entries ?? [];

  return (
    <div>
      <PageHeader
        eyebrow="Exemptions"
        title="Whitelist"
        description="Whitelist entries exempt matching actors or channels from specific Anti-Nuke actions. They never bypass Discord role hierarchy, the T77 owner, or bot permission checks."
        actions={
          <div className="flex gap-2">
            <Button onClick={() => setIncludeRevoked((value) => !value)}>
              {includeRevoked ? 'Hide revoked' : 'Show revoked'}
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              New entry
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card title="Active entries">
          <p className="text-2xl font-semibold tabular-nums">
            {entries.filter((entry) => entry.revokedAt === null).length}
          </p>
        </Card>
        <Card title="Temporary">
          <p className="text-2xl font-semibold tabular-nums">
            {entries.filter((entry) => entry.revokedAt === null && entry.expiresAt !== null).length}
          </p>
        </Card>
        <Card title="Revoked">
          <p className="text-2xl font-semibold tabular-nums text-ash">
            {entries.filter((entry) => entry.revokedAt !== null).length}
          </p>
        </Card>
      </div>

      <Card
        className="mt-6"
        title="Entries"
        description="Expired entries stop applying automatically; their record remains until revoked."
      >
        {entries.length === 0 ? (
          <p className="text-xs text-ash">No whitelist entries.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="t77-table w-full min-w-[860px]">
              <thead>
                <tr>
                  <th>Target</th>
                  <th>Scope</th>
                  <th>Reason</th>
                  <th>Created</th>
                  <th>Expires</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const expired =
                    entry.expiresAt !== null && new Date(entry.expiresAt).getTime() <= Date.now();
                  return (
                    <tr key={entry.id}>
                      <td>
                        <p className="font-mono text-[11px]">{entry.targetId}</p>
                        <p className="mt-0.5 text-[10px] uppercase tracking-wide text-ash">
                          {entry.targetType}
                        </p>
                      </td>
                      <td>
                        <Badge tone={entry.scope === 'GLOBAL' ? 'info' : 'neutral'}>
                          {entry.scope}
                        </Badge>
                        {entry.action !== null && (
                          <p className="mt-1 font-mono text-[10px] text-ash">{entry.action}</p>
                        )}
                      </td>
                      <td className="max-w-[240px] text-xs text-ash">{entry.reason}</td>
                      <td className="text-ash">{formatDate(entry.createdAt)}</td>
                      <td className="text-ash">
                        {entry.expiresAt === null ? 'Never' : relativeTime(entry.expiresAt)}
                      </td>
                      <td>
                        {entry.revokedAt !== null ? (
                          <Badge tone="bad">Revoked</Badge>
                        ) : expired ? (
                          <Badge tone="warn">Expired</Badge>
                        ) : (
                          <Badge tone="good">Active</Badge>
                        )}
                      </td>
                      <td className="text-right">
                        {entry.revokedAt === null && (
                          <Button variant="danger" onClick={() => setRevoking(entry)}>
                            Revoke
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={creating}
        title="New whitelist entry"
        description="Whitelists exempt specific security actions. Use the narrowest scope that solves the problem."
        confirmLabel="Create entry"
        busy={busy}
        onCancel={() => setCreating(false)}
        onConfirm={() => void submit()}
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Target type">
              <Select
                value={form.targetType}
                onChange={(value) => setForm({ ...form, targetType: value })}
                options={[
                  { value: 'USER', label: 'User' },
                  { value: 'ROLE', label: 'Role' },
                  { value: 'CHANNEL', label: 'Channel' },
                ]}
              />
            </Field>
            <Field label="Target ID">
              <TextInput
                value={form.targetId}
                onChange={(value) => setForm({ ...form, targetId: value })}
                placeholder="123456789012345678"
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Scope">
              <Select
                value={form.scope}
                onChange={(value) => setForm({ ...form, scope: value })}
                options={[
                  { value: 'GLOBAL', label: 'All Anti-Nuke actions' },
                  { value: 'ACTION', label: 'One action' },
                ]}
              />
            </Field>
            <Field label="Temporary duration" hint="Leave empty for a permanent entry.">
              <Select
                value={form.duration}
                onChange={(value) => setForm({ ...form, duration: value })}
                options={DURATIONS.map((value) => ({
                  value,
                  label: value === '' ? 'Permanent' : value,
                }))}
              />
            </Field>
          </div>
          {form.scope === 'ACTION' && (
            <Field label="Action">
              <Select
                value={form.action}
                onChange={(value) => setForm({ ...form, action: value })}
                options={[
                  { value: '', label: 'Select an action' },
                  ...ACTIONS.map((value) => ({ value, label: value })),
                ]}
              />
            </Field>
          )}
          <Field label="Reason">
            <TextInput
              value={form.reason}
              onChange={(value) => setForm({ ...form, reason: value })}
              placeholder="Why this exemption exists"
            />
          </Field>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={revoking !== null}
        title="Revoke whitelist entry"
        description="The entry stops applying immediately. The historical record and audit entry are kept."
        confirmLabel="Revoke"
        danger
        busy={busy}
        onCancel={() => setRevoking(null)}
        onConfirm={() => void revoke()}
      />
    </div>
  );
}

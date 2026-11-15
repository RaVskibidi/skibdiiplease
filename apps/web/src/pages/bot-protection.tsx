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
  Toggle,
  useToast,
} from '../components/ui.js';
import { useFetch, useGuildId } from '../hooks.js';
import { useLiveEvent } from '../components/layout.js';
import { api, formatDate, relativeTime } from '../api.js';

interface BotApproval {
  id: string;
  botId: string;
  approvedBy: string;
  reason: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface BotProtectionResponse {
  enabled: boolean;
  approvals: BotApproval[];
  active: BotApproval[];
}

const DURATIONS = ['', '30m', '12h', '7d', '2w'] as const;

export function BotProtectionPage(): React.JSX.Element {
  const guildId = useGuildId();
  const toast = useToast();
  const state = useFetch<BotProtectionResponse>(`/guilds/${guildId}/bot-protection`);
  const live = useLiveEvent();
  const [enabled, setEnabled] = useState(false);
  const [savingToggle, setSavingToggle] = useState(false);
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<BotApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ botId: '', reason: '', duration: '' as string });

  useEffect(() => {
    if (state.data !== null) {
      setEnabled(state.data.enabled);
    }
  }, [state.data]);

  useEffect(() => {
    if (live !== null && live.type !== 'ready') {
      void state.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.at]);

  if (state.loading && state.data === null) {
    return <Spinner label="Loading bot protection" />;
  }
  if (state.error !== null) {
    return <ErrorBanner message={state.error} />;
  }

  const toggle = async (value: boolean): Promise<void> => {
    setSavingToggle(true);
    setEnabled(value);
    try {
      await api.patch(`/guilds/${guildId}/bot-protection`, { enabled: value });
      toast(`Bot protection ${value ? 'enabled' : 'disabled'}.`, 'success');
      await state.reload();
    } catch (caught) {
      setEnabled(!value);
      toast(caught instanceof Error ? caught.message : 'Could not save setting.', 'error');
    } finally {
      setSavingToggle(false);
    }
  };

  const approve = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.post(`/guilds/${guildId}/bot-protection`, {
        botId: form.botId.trim(),
        reason: form.reason.trim(),
        ...(form.duration === '' ? {} : { duration: form.duration }),
      });
      toast('Bot approval recorded.', 'success');
      setAdding(false);
      setForm({ botId: '', reason: '', duration: '' });
      await state.reload();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not approve bot.', 'error');
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
      await api.delete(`/guilds/${guildId}/bot-protection/${revoking.botId}`);
      toast('Bot approval revoked.', 'success');
      setRevoking(null);
      await state.reload();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not revoke approval.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const approvals = state.data?.approvals ?? [];

  return (
    <div>
      <PageHeader
        eyebrow="Integrity"
        title="Bot Protection"
        description="Detect bots added by non-allowlisted actors and require an explicit approval for known integrations. Approval expiry is enforced by the bot at event time."
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            Approve bot
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card title="Protection">
          <p className={`text-2xl font-semibold ${enabled ? 'text-emerald-300' : 'text-ash'}`}>
            {enabled ? 'Enabled' : 'Disabled'}
          </p>
        </Card>
        <Card title="Active approvals">
          <p className="text-2xl font-semibold tabular-nums">{state.data?.active.length ?? 0}</p>
        </Card>
        <Card title="Historical approvals">
          <p className="text-2xl font-semibold tabular-nums text-ash">{approvals.length}</p>
        </Card>
      </div>

      <Card
        className="mt-6"
        title="Master switch"
        description="Only the server owner or a T77 staff grant with security.config may change this."
      >
        <Toggle
          checked={enabled}
          onChange={(value) => {
            if (!savingToggle) {
              void toggle(value);
            }
          }}
          label="Bot protection enabled"
          description="New bot additions are evaluated against the approval list below."
          disabled={savingToggle}
        />
      </Card>

      <Card
        className="mt-6"
        title="Approvals"
        description="A revoked or expired approval stops being honored without deleting history."
      >
        {approvals.length === 0 ? (
          <p className="text-xs text-ash">No bot approvals recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="t77-table w-full min-w-[760px]">
              <thead>
                <tr>
                  <th>Bot ID</th>
                  <th>Reason</th>
                  <th>Approved by</th>
                  <th>Created</th>
                  <th>Expires</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {approvals.map((approval) => {
                  const expired =
                    approval.expiresAt !== null &&
                    new Date(approval.expiresAt).getTime() <= Date.now();
                  return (
                    <tr key={approval.id}>
                      <td className="font-mono text-[11px]">{approval.botId}</td>
                      <td className="max-w-[240px] text-xs text-ash">{approval.reason}</td>
                      <td className="font-mono text-[11px] text-ash">{approval.approvedBy}</td>
                      <td className="text-ash">{formatDate(approval.createdAt)}</td>
                      <td className="text-ash">
                        {approval.expiresAt === null ? 'Never' : relativeTime(approval.expiresAt)}
                      </td>
                      <td>
                        {approval.revokedAt !== null ? (
                          <Badge tone="bad">Revoked</Badge>
                        ) : expired ? (
                          <Badge tone="warn">Expired</Badge>
                        ) : (
                          <Badge tone="good">Approved</Badge>
                        )}
                      </td>
                      <td className="text-right">
                        {approval.revokedAt === null && (
                          <Button variant="danger" onClick={() => setRevoking(approval)}>
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
        open={adding}
        title="Approve a bot"
        description="Approving a bot suppresses bot-protection containment for that bot ID. Only approve integrations you recognize."
        confirmLabel="Approve"
        busy={busy}
        onCancel={() => setAdding(false)}
        onConfirm={() => void approve()}
      >
        <div className="space-y-3">
          <Field label="Bot user ID">
            <TextInput
              value={form.botId}
              onChange={(value) => setForm({ ...form, botId: value })}
              placeholder="123456789012345678"
            />
          </Field>
          <Field label="Reason">
            <TextInput
              value={form.reason}
              onChange={(value) => setForm({ ...form, reason: value })}
              placeholder="Why this bot is trusted"
            />
          </Field>
          <Field label="Expiry" hint="Temporary approvals expire automatically.">
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
      </ConfirmDialog>

      <ConfirmDialog
        open={revoking !== null}
        title="Revoke bot approval"
        description="T77 will treat this bot as untrusted again and may contain it according to policy."
        confirmLabel="Revoke"
        danger
        busy={busy}
        onCancel={() => setRevoking(null)}
        onConfirm={() => void revoke()}
      />
    </div>
  );
}

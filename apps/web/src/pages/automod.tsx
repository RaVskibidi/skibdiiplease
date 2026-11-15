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
  TextArea,
  TextInput,
  Toggle,
  useToast,
} from '../components/ui.js';
import { useFetch, useGuildId } from '../hooks.js';
import { useLiveEvent } from '../components/layout.js';
import { api } from '../api.js';

interface AutomodConfig {
  enabled: boolean;
  floodMessages: number;
  floodWindowSeconds: number;
  duplicateWindowSeconds: number;
  duplicateThreshold: number;
  mentionLimit: number;
  capsPercentage: number;
  capsMinimumLength: number;
  inviteLinksBlocked: boolean;
  linkFilterEnabled: boolean;
  bannedWords: string[];
  blockedDomains: string[];
  exemptChannelIds: string[];
  exemptRoleIds: string[];
  exemptUserIds: string[];
  ignoreStaff: boolean;
  warnEnabled: boolean;
  timeoutEnabled: boolean;
  timeoutAfterWarnings: number;
  deleteOffendingMessage: boolean;
  highConfidenceRules: string[];
  timeoutSeconds: number;
}

const RULES = [
  'FLOOD',
  'DUPLICATE',
  'MENTION_SPAM',
  'EXCESSIVE_CAPS',
  'INVITE_LINK',
  'BLOCKED_LINK',
  'BLOCKED_WORD',
  'EVERYONE_MENTION',
] as const;

const splitList = (value: string): string[] =>
  value
    .split(/[\n,]/u)
    .map((item) => item.trim())
    .filter(Boolean);

export function AutomodPage(): React.JSX.Element {
  const guildId = useGuildId();
  const toast = useToast();
  const state = useFetch<{ config: AutomodConfig }>(`/guilds/${guildId}/automod`);
  const live = useLiveEvent();
  const [form, setForm] = useState<AutomodConfig | null>(null);
  const [words, setWords] = useState('');
  const [domains, setDomains] = useState('');
  const [exempt, setExempt] = useState({ channels: '', roles: '', users: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (state.data !== null) {
      const config = state.data.config;
      setForm(config);
      setWords(config.bannedWords.join('\n'));
      setDomains(config.blockedDomains.join('\n'));
      setExempt({
        channels: config.exemptChannelIds.join(', '),
        roles: config.exemptRoleIds.join(', '),
        users: config.exemptUserIds.join(', '),
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
    return <Spinner label="Loading AutoMod policy" />;
  }
  if (state.error !== null) {
    return <ErrorBanner message={state.error} />;
  }
  if (form === null) {
    return <ErrorBanner message="AutoMod configuration is unavailable." />;
  }

  const patch = <K extends keyof AutomodConfig>(key: K, value: AutomodConfig[K]): void => {
    setForm((current) => (current === null ? current : { ...current, [key]: value }));
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.patch(`/guilds/${guildId}/automod`, {
        ...form,
        bannedWords: splitList(words),
        blockedDomains: splitList(domains),
        exemptChannelIds: splitList(exempt.channels),
        exemptRoleIds: splitList(exempt.roles),
        exemptUserIds: splitList(exempt.users),
      });
      toast('AutoMod policy saved.', 'success');
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
        eyebrow="Content"
        title="AutoMod"
        description="Message policy evaluated by the T77 engine. Content rules require the Message Content intent; without it the dashboard reports AutoMod as degraded."
        actions={
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving...' : 'Save policy'}
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Enforcement">
          <Toggle
            checked={form.enabled}
            onChange={(value) => patch('enabled', value)}
            label="AutoMod enabled"
          />
          <Toggle
            checked={form.deleteOffendingMessage}
            onChange={(value) => patch('deleteOffendingMessage', value)}
            label="Delete offending message"
          />
          <Toggle
            checked={form.warnEnabled}
            onChange={(value) => patch('warnEnabled', value)}
            label="Record a warning"
          />
          <Toggle
            checked={form.timeoutEnabled}
            onChange={(value) => patch('timeoutEnabled', value)}
            label="Timeout repeat offenders"
          />
          <Toggle
            checked={form.ignoreStaff}
            onChange={(value) => patch('ignoreStaff', value)}
            label="Ignore staff"
            description="Members with moderation permissions are exempt."
          />
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Timeout after warnings">
              <NumberInput
                value={form.timeoutAfterWarnings}
                min={1}
                max={10}
                onChange={(value) => patch('timeoutAfterWarnings', value)}
              />
            </Field>
            <Field label="Timeout seconds">
              <NumberInput
                value={form.timeoutSeconds}
                min={60}
                max={2_419_200}
                onChange={(value) => patch('timeoutSeconds', value)}
              />
            </Field>
          </div>
        </Card>

        <Card title="Filters">
          <Toggle
            checked={form.inviteLinksBlocked}
            onChange={(value) => patch('inviteLinksBlocked', value)}
            label="Block Discord invites"
          />
          <Toggle
            checked={form.linkFilterEnabled}
            onChange={(value) => patch('linkFilterEnabled', value)}
            label="Block listed domains"
          />
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Mention limit">
              <NumberInput
                value={form.mentionLimit}
                min={2}
                max={50}
                onChange={(value) => patch('mentionLimit', value)}
              />
            </Field>
            <Field label="Caps percentage">
              <NumberInput
                value={form.capsPercentage}
                min={50}
                max={100}
                onChange={(value) => patch('capsPercentage', value)}
              />
            </Field>
            <Field label="Caps minimum length">
              <NumberInput
                value={form.capsMinimumLength}
                min={5}
                max={200}
                onChange={(value) => patch('capsMinimumLength', value)}
              />
            </Field>
            <Field label="Duplicate threshold">
              <NumberInput
                value={form.duplicateThreshold}
                min={2}
                max={20}
                onChange={(value) => patch('duplicateThreshold', value)}
              />
            </Field>
          </div>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card
          title="Banned words"
          description="One entry per line. Matched case-insensitively by the engine."
        >
          <TextArea
            value={words}
            onChange={setWords}
            rows={8}
            placeholder={'badword\nanother phrase'}
          />
        </Card>
        <Card
          title="Blocked domains"
          description="One domain per line. Only applies when the link filter is enabled."
        >
          <TextArea
            value={domains}
            onChange={setDomains}
            rows={8}
            placeholder={'example.com\nspam.invalid'}
          />
        </Card>
      </div>

      <Card
        className="mt-6"
        title="Exemptions"
        description="Comma-separated Discord IDs. Whitelisted users also pass through the security exemption check."
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <Field label="Exempt channels">
            <TextInput
              value={exempt.channels}
              onChange={(value) => setExempt({ ...exempt, channels: value })}
            />
          </Field>
          <Field label="Exempt roles">
            <TextInput
              value={exempt.roles}
              onChange={(value) => setExempt({ ...exempt, roles: value })}
            />
          </Field>
          <Field label="Exempt users">
            <TextInput
              value={exempt.users}
              onChange={(value) => setExempt({ ...exempt, users: value })}
            />
          </Field>
        </div>
      </Card>

      <Card
        className="mt-6"
        title="High-confidence rules"
        description="Single-message rules that may act immediately. Empty by default so a first message can never be punished without opt-in."
      >
        <div className="flex flex-wrap gap-2">
          {RULES.map((rule) => {
            const selected = form.highConfidenceRules.includes(rule);
            return (
              <button
                key={rule}
                type="button"
                onClick={() =>
                  patch(
                    'highConfidenceRules',
                    selected
                      ? form.highConfidenceRules.filter((value) => value !== rule)
                      : [...form.highConfidenceRules, rule],
                  )
                }
                className={`rounded-lg border px-3 py-1.5 text-[11px] font-semibold transition ${
                  selected
                    ? 'border-blood/60 bg-blood/15 text-blood-soft'
                    : 'border-edge-strong bg-panel-2 text-ash hover:text-chalk'
                }`}
              >
                {selected ? '✓ ' : ''}
                {rule}
              </button>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

interface AntiSpamResponse {
  config: AutomodConfig;
  section: Record<string, unknown>;
}

export function AntiSpamPage(): React.JSX.Element {
  const guildId = useGuildId();
  const toast = useToast();
  const state = useFetch<AntiSpamResponse>(`/guilds/${guildId}/anti-spam`);
  const live = useLiveEvent();
  const [form, setForm] = useState<AutomodConfig | null>(null);
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
    return <Spinner label="Loading anti-spam policy" />;
  }
  if (state.error !== null) {
    return <ErrorBanner message={state.error} />;
  }
  if (form === null) {
    return <ErrorBanner message="Anti-spam configuration is unavailable." />;
  }

  const keys: Array<keyof AutomodConfig> = [
    'enabled',
    'floodMessages',
    'floodWindowSeconds',
    'duplicateWindowSeconds',
    'duplicateThreshold',
    'mentionLimit',
    'capsPercentage',
    'capsMinimumLength',
    'inviteLinksBlocked',
    'ignoreStaff',
    'warnEnabled',
    'timeoutEnabled',
    'timeoutAfterWarnings',
    'deleteOffendingMessage',
    'timeoutSeconds',
  ];

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const payload = Object.fromEntries(keys.map((key) => [key, form[key]]));
      await api.patch(`/guilds/${guildId}/anti-spam`, payload);
      toast('Anti-spam policy saved.', 'success');
      await state.reload();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Save failed.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const patch = <K extends keyof AutomodConfig>(key: K, value: AutomodConfig[K]): void => {
    setForm((current) => (current === null ? current : { ...current, [key]: value }));
  };

  return (
    <div>
      <PageHeader
        eyebrow="Content"
        title="Anti-Spam"
        description="Flood, duplicate, mention, and caps policies. These rules share the AutoMod engine and are evaluated on message events."
        actions={
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving...' : 'Save policy'}
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Rate limits">
          <Toggle
            checked={form.enabled}
            onChange={(value) => patch('enabled', value)}
            label="Anti-spam enabled"
          />
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Messages per window">
              <NumberInput
                value={form.floodMessages}
                min={2}
                max={100}
                onChange={(value) => patch('floodMessages', value)}
              />
            </Field>
            <Field label="Flood window (seconds)">
              <NumberInput
                value={form.floodWindowSeconds}
                min={3}
                max={300}
                onChange={(value) => patch('floodWindowSeconds', value)}
              />
            </Field>
            <Field label="Duplicate window (seconds)">
              <NumberInput
                value={form.duplicateWindowSeconds}
                min={10}
                max={3_600}
                onChange={(value) => patch('duplicateWindowSeconds', value)}
              />
            </Field>
            <Field label="Duplicate threshold">
              <NumberInput
                value={form.duplicateThreshold}
                min={2}
                max={20}
                onChange={(value) => patch('duplicateThreshold', value)}
              />
            </Field>
            <Field label="Mention limit">
              <NumberInput
                value={form.mentionLimit}
                min={2}
                max={50}
                onChange={(value) => patch('mentionLimit', value)}
              />
            </Field>
            <Field label="Caps percentage">
              <NumberInput
                value={form.capsPercentage}
                min={50}
                max={100}
                onChange={(value) => patch('capsPercentage', value)}
              />
            </Field>
            <Field label="Caps minimum length">
              <NumberInput
                value={form.capsMinimumLength}
                min={5}
                max={200}
                onChange={(value) => patch('capsMinimumLength', value)}
              />
            </Field>
            <Field label="Timeout seconds">
              <NumberInput
                value={form.timeoutSeconds}
                min={60}
                max={2_419_200}
                onChange={(value) => patch('timeoutSeconds', value)}
              />
            </Field>
          </div>
        </Card>

        <Card title="Responses">
          <Toggle
            checked={form.warnEnabled}
            onChange={(value) => patch('warnEnabled', value)}
            label="Warn before timing out"
          />
          <Toggle
            checked={form.timeoutEnabled}
            onChange={(value) => patch('timeoutEnabled', value)}
            label="Timeout after repeated warnings"
          />
          <Toggle
            checked={form.deleteOffendingMessage}
            onChange={(value) => patch('deleteOffendingMessage', value)}
            label="Delete offending messages"
          />
          <Toggle
            checked={form.inviteLinksBlocked}
            onChange={(value) => patch('inviteLinksBlocked', value)}
            label="Block invites"
          />
          <Toggle
            checked={form.ignoreStaff}
            onChange={(value) => patch('ignoreStaff', value)}
            label="Ignore staff"
          />
          <div className="mt-3">
            <Field label="Timeout after warnings">
              <NumberInput
                value={form.timeoutAfterWarnings}
                min={1}
                max={10}
                onChange={(value) => patch('timeoutAfterWarnings', value)}
              />
            </Field>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <Badge tone={form.enabled ? 'good' : 'neutral'}>
              {form.enabled ? 'Evaluating messages' : 'Disabled'}
            </Badge>
            {form.timeoutEnabled && <Badge tone="warn">Timeouts permitted</Badge>}
          </div>
        </Card>
      </div>
    </div>
  );
}

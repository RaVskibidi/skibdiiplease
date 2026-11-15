import { useEffect, useMemo, useState } from 'react';

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
  useToast,
} from '../components/ui.js';
import { useFetch, useGuildId } from '../hooks.js';
import { useLiveEvent } from '../components/layout.js';
import { api, formatDate, relativeTime } from '../api.js';

interface Backup {
  id: string;
  type: string;
  status: string;
  schemaVersion: number;
  checksum: string | null;
  sizeBytes: string | null;
  createdBy: string;
  retentionUntil: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface RestoreJob {
  id: string;
  backupId: string;
  status: string;
  progress: number;
  confirmationId: string | null;
  requestedBy: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface BackupsResponse {
  backups: Backup[];
  restores: RestoreJob[];
  schedule: {
    enabled: boolean;
    intervalHours: number;
    retentionDays: number;
    lastScheduledBackupAt: string | null;
  };
  unsupported: string[];
}

interface DashboardAction {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

interface PreviewResult {
  jobId: string;
  counts: Record<string, number>;
  warnings: string[];
  unsupported: string[];
  items: Array<Record<string, unknown>>;
}

const CATEGORIES = [
  { value: 'roles', label: 'Roles' },
  { value: 'channels', label: 'Channels' },
  { value: 'permissions', label: 'Permissions' },
  { value: 'emojis', label: 'Emojis' },
  { value: 'stickers', label: 'Stickers' },
  { value: 'guildSettings', label: 'Guild settings' },
] as const;

async function waitForAction(guildId: string, actionId: string): Promise<DashboardAction> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await api.get<{ action: DashboardAction }>(
      `/guilds/${guildId}/actions/${actionId}`,
    );
    if (response.action.status === 'COMPLETED' || response.action.status === 'FAILED') {
      return response.action;
    }
    if (response.action.status === 'CANCELLED') {
      throw new Error('The queued action was cancelled.');
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(
    'T77 has not executed this action yet. The bot may be offline; check the overview page and retry.',
  );
}

export function BackupsPage(): React.JSX.Element {
  const guildId = useGuildId();
  const toast = useToast();
  const state = useFetch<BackupsResponse>(`/guilds/${guildId}/backups`);
  const live = useLiveEvent();
  const [busy, setBusy] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [retention, setRetention] = useState(30);
  const [deleting, setDeleting] = useState<Backup | null>(null);
  const [previewing, setPreviewing] = useState<Backup | null>(null);
  const [selection, setSelection] = useState<string[]>([
    'roles',
    'channels',
    'permissions',
    'emojis',
    'stickers',
    'guildSettings',
  ]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [restoreTarget, setRestoreTarget] = useState<Backup | null>(null);

  useEffect(() => {
    if (live !== null && live.type !== 'ready') {
      void state.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.at]);

  const backups = state.data?.backups ?? [];
  const ready = useMemo(() => backups.filter((backup) => backup.status === 'READY'), [backups]);

  if (state.loading && state.data === null) {
    return <Spinner label="Loading backups" />;
  }
  if (state.error !== null) {
    return <ErrorBanner message={state.error} />;
  }

  const runCreate = async (): Promise<void> => {
    setBusy('create');
    try {
      const response = await api.post<{ action: DashboardAction }>(`/guilds/${guildId}/backups`, {
        retentionDays: retention,
        confirm: true,
      });
      const action = await waitForAction(guildId, response.action.id);
      if (action.status !== 'COMPLETED') {
        throw new Error(action.error ?? 'Backup failed.');
      }
      toast('Backup captured.', 'success');
      setCreateOpen(false);
      await state.reload();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Backup failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const runDelete = async (): Promise<void> => {
    if (deleting === null) {
      return;
    }
    setBusy('delete');
    try {
      const response = await api.delete<{ action: DashboardAction }>(
        `/guilds/${guildId}/backups/${deleting.id}`,
        { confirm: true },
      );
      const action = await waitForAction(guildId, response.action.id);
      if (action.status !== 'COMPLETED') {
        throw new Error(action.error ?? 'Delete failed.');
      }
      toast('Backup deleted.', 'success');
      setDeleting(null);
      await state.reload();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Delete failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const runPreview = async (): Promise<void> => {
    if (previewing === null) {
      return;
    }
    if (selection.length === 0) {
      toast('Select at least one restore category.', 'error');
      return;
    }
    setBusy('preview');
    setPreview(null);
    try {
      const response = await api.post<{ action: DashboardAction }>(
        `/guilds/${guildId}/backups/${previewing.id}/preview`,
        { selection: { categories: selection }, confirm: true },
      );
      const action = await waitForAction(guildId, response.action.id);
      if (action.status !== 'COMPLETED' || action.result === null) {
        throw new Error(action.error ?? 'Preview failed.');
      }
      setPreview(action.result as unknown as PreviewResult);
      toast('Restore preview ready.', 'success');
      await state.reload();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Preview failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const runRestore = async (): Promise<void> => {
    if (preview === null || restoreTarget === null) {
      return;
    }
    if (confirmation.trim().length < 6) {
      toast('Type the confirmation word exactly.', 'error');
      return;
    }
    setBusy('restore');
    try {
      const response = await api.post<{ action: DashboardAction }>(
        `/guilds/${guildId}/backups/${restoreTarget.id}/restore`,
        {
          jobId: preview.jobId,
          confirmationId: confirmation.trim(),
          confirm: true,
        },
      );
      const action = await waitForAction(guildId, response.action.id);
      if (action.status !== 'COMPLETED') {
        throw new Error(action.error ?? 'Restore failed.');
      }
      toast('Restore completed. Review the job result for per-item errors.', 'success');
      setRestoring(false);
      setRestoreTarget(null);
      setConfirmation('');
      setPreview(null);
      setPreviewing(null);
      await state.reload();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Restore failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="Recovery"
        title="Backups"
        description="Configuration snapshots captured by the T77 bot. Restore always requires a preview, an explicit confirmation, and a fresh pre-restore backup."
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)} disabled={busy !== null}>
            Create backup
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card title="Schedule">
          <p
            className={`text-2xl font-semibold ${state.data?.schedule.enabled ? 'text-emerald-300' : 'text-ash'}`}
          >
            {state.data?.schedule.enabled ? 'Enabled' : 'Disabled'}
          </p>
          <p className="mt-1 text-xs text-ash">
            Every {state.data?.schedule.intervalHours ?? 0}h · retain{' '}
            {state.data?.schedule.retentionDays ?? 0} days
          </p>
        </Card>
        <Card title="Backups stored">
          <p className="text-2xl font-semibold tabular-nums">{backups.length}</p>
          <p className="mt-1 text-xs text-ash">{ready.length} ready to restore</p>
        </Card>
        <Card title="Last scheduled">
          <p className="text-sm font-semibold">
            {formatDate(state.data?.schedule.lastScheduledBackupAt)}
          </p>
          <p className="mt-1 text-xs text-ash">Schedule is controlled from Settings.</p>
        </Card>
      </div>

      <Card
        className="mt-6"
        title="Snapshots"
        description="Object bytes live in storage; metadata lives in PostgreSQL."
      >
        {backups.length === 0 ? (
          <p className="text-xs text-ash">No backups captured yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="t77-table w-full min-w-[820px]">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Size</th>
                  <th>Created</th>
                  <th>Retention</th>
                  <th>By</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {backups.map((backup) => (
                  <tr key={backup.id}>
                    <td>
                      <p className="font-medium">{backup.type}</p>
                      <p className="font-mono text-[10px] text-ash">{backup.id}</p>
                    </td>
                    <td>
                      <Badge
                        tone={
                          backup.status === 'READY'
                            ? 'good'
                            : backup.status === 'FAILED'
                              ? 'bad'
                              : backup.status === 'DELETED'
                                ? 'neutral'
                                : 'warn'
                        }
                      >
                        {backup.status}
                      </Badge>
                      {backup.error !== null && (
                        <p className="mt-1 max-w-[200px] text-[10px] text-blood-soft">
                          {backup.error}
                        </p>
                      )}
                    </td>
                    <td className="font-mono text-[11px] text-ash">
                      {backup.sizeBytes === null
                        ? '-'
                        : `${(Number(backup.sizeBytes) / 1024).toFixed(1)} KiB`}
                    </td>
                    <td className="text-ash">{formatDate(backup.createdAt)}</td>
                    <td className="text-ash">
                      {backup.retentionUntil === null
                        ? 'Keep'
                        : relativeTime(backup.retentionUntil)}
                    </td>
                    <td className="font-mono text-[11px] text-ash">{backup.createdBy}</td>
                    <td>
                      <div className="flex justify-end gap-2">
                        {backup.status === 'READY' && (
                          <Button
                            onClick={() => {
                              setPreviewing(backup);
                              setPreview(null);
                              setSelection([
                                'roles',
                                'channels',
                                'permissions',
                                'emojis',
                                'stickers',
                                'guildSettings',
                              ]);
                            }}
                            disabled={busy !== null}
                          >
                            Preview restore
                          </Button>
                        )}
                        {backup.status !== 'DELETED' && (
                          <Button
                            variant="danger"
                            onClick={() => setDeleting(backup)}
                            disabled={busy !== null}
                          >
                            Delete
                          </Button>
                        )}
                      </div>
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
        title="Restore jobs"
        description="Preview and execution history for this server."
      >
        {(state.data?.restores.length ?? 0) === 0 ? (
          <p className="text-xs text-ash">No restore jobs recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="t77-table w-full min-w-[620px]">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Requested by</th>
                  <th>Created</th>
                  <th>Completed</th>
                </tr>
              </thead>
              <tbody>
                {state.data?.restores.map((job) => (
                  <tr key={job.id}>
                    <td className="font-mono text-[10px]">{job.id}</td>
                    <td>
                      <Badge
                        tone={
                          job.status === 'COMPLETED'
                            ? 'good'
                            : job.status === 'FAILED'
                              ? 'bad'
                              : job.status === 'PREVIEWED'
                                ? 'info'
                                : 'warn'
                        }
                      >
                        {job.status}
                      </Badge>
                    </td>
                    <td className="font-mono text-[11px]">{job.progress}%</td>
                    <td className="font-mono text-[11px] text-ash">{job.requestedBy}</td>
                    <td className="text-ash">{formatDate(job.createdAt)}</td>
                    <td className="text-ash">{formatDate(job.completedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        className="mt-6"
        title="What T77 cannot recover"
        description="Stated plainly so no restore is oversold."
      >
        <ul className="space-y-2">
          {state.data?.unsupported.map((item) => (
            <li
              key={item}
              className="rounded-lg border border-edge bg-[#0d0f13] px-3 py-2 text-xs leading-relaxed text-ash"
            >
              {item}
            </li>
          ))}
        </ul>
      </Card>

      <ConfirmDialog
        open={createOpen}
        title="Create backup"
        description="The bot captures the current guild configuration and uploads it to storage. The request is queued and may take a few seconds."
        confirmLabel="Queue backup"
        busy={busy === 'create'}
        onCancel={() => setCreateOpen(false)}
        onConfirm={() => void runCreate()}
      >
        <Field label="Retention (days)">
          <NumberInput value={retention} min={1} max={3_650} onChange={setRetention} />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete backup"
        description="The stored snapshot object and its metadata are removed. This cannot be undone."
        confirmLabel="Delete backup"
        danger
        busy={busy === 'delete'}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void runDelete()}
      />

      <ConfirmDialog
        open={previewing !== null}
        title={`Preview restore from ${previewing?.type ?? 'backup'}`}
        description="Select the categories to compare. Preview does not modify Discord; it records a restore job you can then confirm."
        confirmLabel={busy === 'preview' ? 'Building preview...' : 'Build preview'}
        busy={busy === 'preview'}
        onCancel={() => {
          setPreviewing(null);
          setPreview(null);
        }}
        onConfirm={() => void runPreview()}
      >
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            {CATEGORIES.map((category) => {
              const checked = selection.includes(category.value);
              return (
                <label
                  key={category.value}
                  className="flex items-center gap-2 rounded-lg border border-edge bg-[#0d0f13] px-3 py-2 text-xs"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) =>
                      setSelection((current) =>
                        event.target.checked
                          ? [...current, category.value]
                          : current.filter((value) => value !== category.value),
                      )
                    }
                  />
                  {category.label}
                </label>
              );
            })}
          </div>

          {preview !== null && (
            <div className="rounded-lg border border-edge bg-[#0d0f13] p-3">
              <p className="text-[10px] uppercase tracking-wide text-ash">Preview result</p>
              <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                {Object.entries(preview.counts).map(([key, value]) => (
                  <div key={key} className="rounded-md border border-edge px-2 py-1.5">
                    <p className="text-[10px] uppercase text-ash">{key}</p>
                    <p className="font-mono font-semibold">{value}</p>
                  </div>
                ))}
              </div>
              <p className="mt-2 font-mono text-[10px] text-ash">Job {preview.jobId}</p>
              {preview.unsupported.length > 0 && (
                <ul className="mt-2 space-y-1 text-[10px] leading-relaxed text-ash">
                  {preview.unsupported.map((item) => (
                    <li key={item}>- {item}</li>
                  ))}
                </ul>
              )}
              {preview.warnings.length > 0 && (
                <ul className="mt-2 space-y-1 text-[10px] leading-relaxed text-amber-300">
                  {preview.warnings.map((item) => (
                    <li key={item}>- {item}</li>
                  ))}
                </ul>
              )}
              <Button
                variant="danger"
                className="mt-3"
                disabled={busy !== null}
                onClick={() => {
                  setRestoreTarget(previewing);
                  setRestoring(true);
                }}
              >
                Continue to restore
              </Button>
            </div>
          )}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={restoring}
        title="Execute restore"
        description="T77 creates a pre-restore backup first, then applies the previewed changes. Recreated roles and channels receive new Discord IDs. Type RESTORE to confirm."
        confirmLabel="Execute restore"
        danger
        busy={busy === 'restore'}
        onCancel={() => {
          setRestoring(false);
          setConfirmation('');
        }}
        onConfirm={() => void runRestore()}
      >
        <Field label="Confirmation" hint="Must match exactly.">
          <TextInput value={confirmation} onChange={setConfirmation} placeholder="RESTORE" />
        </Field>
      </ConfirmDialog>
    </div>
  );
}

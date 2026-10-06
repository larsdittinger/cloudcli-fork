import { useState } from 'react';
import { Check, Copy, Loader2, Pause, Pencil, Play, Trash2, X } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { Schedule } from '@/shared/types';
import KindLabel from '@/modules/schedules/KindLabel';
import StatusPill from '@/modules/schedules/StatusPill';
import { formatDateTime } from '@/modules/schedules/utils/scheduleFormat';

type Props = {
  schedule: Schedule;
  /** Shown in the all-projects view, where cards from several projects mix. */
  showProject: boolean;
  onEdit: () => void;
  onChanged: () => void;
};

type Busy = 'run' | 'toggle' | 'duplicate' | 'delete' | 'approve' | null;

const PERMISSION_LABEL: Record<string, string> = {
  bypassPermissions: 'autonomous (nobody approves tool calls)',
  acceptEdits: 'accept edits',
  default: 'asks in the chat',
  plan: 'plan only',
};

/** Everything an approval lets run, written out in full — the approval is the only gate for agent proposals. */
function ProposalDetails({ schedule }: { schedule: Schedule }) {
  const usesAgent = schedule.kind === 'prompt' || schedule.handoff === 'on_output';
  const rows: Array<[string, string]> = [['Runs in', schedule.projectPath]];
  if (schedule.kind === 'script') rows.push(['Timeout', `${Math.round(schedule.timeoutSec / 60)} min`]);
  if (usesAgent) {
    rows.push(['Agent', `${schedule.provider}${schedule.model ? ` / ${schedule.model}` : ''}${schedule.effort ? ` · ${schedule.effort}` : ''}`]);
    rows.push(['Permissions', PERMISSION_LABEL[schedule.permissionMode] ?? schedule.permissionMode]);
    rows.push(['Chat', schedule.sessionMode === 'continue' ? 'one chat across runs' : 'new chat each run']);
  }
  const block = 'mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 font-mono text-xs';
  return (
    <section aria-label="What you approve" className="mt-2 space-y-2 text-xs">
      {schedule.kind === 'script' && (
        <div>
          <p className="font-medium">Command</p>
          <pre className={block}>{schedule.command}</pre>
        </div>
      )}
      {usesAgent && (
        <div>
          <p className="font-medium">{schedule.kind === 'script' ? 'Hand-off prompt (when the script prints something)' : 'Prompt'}</p>
          <pre className={block}>{schedule.prompt || '(default hand-off prompt)'}</pre>
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function projectName(projectPath: string): string {
  return projectPath.split('/').filter(Boolean).pop() ?? projectPath;
}

/** Used by SchedulesPanel: one schedule with what it does, when it runs next and its actions. */
export default function ScheduleCard({ schedule, showProject, onEdit, onChanged }: Props) {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const proposal = schedule.proposal;

  const act = async (kind: Busy, request: () => Promise<Response>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(kind);
    setError(null);
    try {
      await readApiJson(await request());
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const spinner = (kind: Busy) => busy === kind && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />;
  const what = schedule.kind === 'prompt' ? schedule.prompt : schedule.command;

  return (
    <article
      className={cn(
        'rounded-lg border p-3',
        proposal ? 'border-amber-500/50 bg-amber-500/5' : 'border-border/60',
        !proposal && !schedule.enabled && 'opacity-70',
      )}
      aria-label={schedule.name}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-medium">{schedule.name}</h3>
            <KindLabel kind={schedule.kind} handoff={schedule.handoff === 'on_output'} />
            {showProject && <span className="text-xs text-muted-foreground" title={schedule.projectPath}>in {projectName(schedule.projectPath)}</span>}
            {!proposal && !schedule.enabled && <span className="text-xs text-muted-foreground">Paused</span>}
          </div>
          <p className="text-sm">{schedule.summary}</p>
          {!proposal && (
            <p className="truncate text-xs text-muted-foreground" title={what}>
              {schedule.kind === 'script' ? <code>{what}</code> : what}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-0.5 text-xs tabular-nums text-muted-foreground">
            <span>Next: {schedule.enabled && !proposal ? formatDateTime(schedule.nextRunAt) : '—'}</span>
            <span className="inline-flex items-center gap-1.5">Last: <StatusPill status={schedule.lastStatus} />{schedule.lastRunAt && formatDateTime(schedule.lastRunAt)}</span>
          </div>
        </div>

        {!proposal && (
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="outline" onClick={() => act('run', () => api.schedules.runNow(schedule.id))} disabled={busy !== null}>
              {spinner('run') || <Play className="h-3.5 w-3.5" aria-hidden />}<span className="ml-1">Run now</span>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => act('toggle', () => api.schedules.update(schedule.id, { enabled: !schedule.enabled }))} disabled={busy !== null} aria-label={schedule.enabled ? 'Pause' : 'Resume'}>
              {spinner('toggle') || (schedule.enabled ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />)}
              <span className="ml-1 hidden sm:inline">{schedule.enabled ? 'Pause' : 'Resume'}</span>
            </Button>
            <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy !== null} aria-label="Edit"><Pencil className="h-3.5 w-3.5" aria-hidden /></Button>
            <Button size="sm" variant="ghost" onClick={() => act('duplicate', () => api.schedules.duplicate(schedule.id))} disabled={busy !== null} aria-label="Duplicate">
              {spinner('duplicate') || <Copy className="h-3.5 w-3.5" aria-hidden />}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => act('delete', () => api.schedules.remove(schedule.id), `Delete “${schedule.name}” and its run history?`)} disabled={busy !== null} aria-label="Delete">
              {spinner('delete') || <Trash2 className="h-3.5 w-3.5" aria-hidden />}
            </Button>
          </div>
        )}
      </div>

      {proposal && (
        <div className="mt-3 border-t border-amber-500/30 pt-2 text-sm">
          <p className="font-medium text-amber-800 dark:text-amber-200">Proposed by an agent — nothing runs until you approve it.</p>
          {proposal.note && <p className="mt-1 whitespace-pre-wrap">{proposal.note}</p>}
          <ProposalDetails schedule={schedule} />
          <p className="mt-1 text-xs text-muted-foreground">
            Proposed {formatDateTime(proposal.createdAt)}
            {proposal.projectPath && <span title={proposal.projectPath}> by an agent in {projectName(proposal.projectPath)}</span>}

          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => act('approve', () => api.schedules.approve(schedule.id))} disabled={busy !== null}>
              {spinner('approve') || <Check className="h-3.5 w-3.5" aria-hidden />}<span className="ml-1">Approve</span>
            </Button>
            <Button size="sm" variant="outline" onClick={onEdit} disabled={busy !== null}><Pencil className="h-3.5 w-3.5" aria-hidden /><span className="ml-1">Edit first</span></Button>
            <Button size="sm" variant="ghost" onClick={() => act('delete', () => api.schedules.remove(schedule.id), `Reject and delete the proposed “${schedule.name}”?`)} disabled={busy !== null}>
              {spinner('delete') || <X className="h-3.5 w-3.5" aria-hidden />}<span className="ml-1">Reject</span>
            </Button>
          </div>
        </div>
      )}

      {error && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-300">{error}</p>}
    </article>
  );
}

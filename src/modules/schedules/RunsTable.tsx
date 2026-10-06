import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Loader2, MessageSquare } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { ScheduleRun } from '@/shared/types';
import KindLabel from '@/modules/schedules/KindLabel';
import StatusPill from '@/modules/schedules/StatusPill';
import { formatDateTime } from '@/shared/utils';
import { formatDuration } from '@/modules/schedules/utils/scheduleFormat';

type Props = {
  runs: ScheduleRun[];
  status: string;
  onStatusChange: (status: string) => void;
};

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' },
  { value: 'timeout', label: 'Timed out' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'missed', label: 'Missed' },
];

/** Used by SchedulesPanel: the run history as one readable table, newest first. */
export default function RunsTable({ runs, status, onStatusChange }: Props) {
  const navigate = useNavigate();
  const [viewing, setViewing] = useState<ScheduleRun | null>(null);
  const [log, setLog] = useState<{ text: string; loading: boolean }>({ text: '', loading: false });

  const openOutput = async (run: ScheduleRun) => {
    setViewing(run);
    setLog({ text: run.output ?? '', loading: run.hasLog });
    if (!run.hasLog) return;
    try {
      const data = await readApiJson<{ data: ScheduleRun }>(await api.schedules.run(run.id, true));
      setLog({ text: data.data.log ?? data.data.output ?? '', loading: false });
    } catch {
      setLog((current) => ({ ...current, loading: false }));
    }
  };

  return (
    <section aria-labelledby="schedule-runs-heading" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="schedule-runs-heading" className="text-sm font-semibold">Run history</h2>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Show
          <select className="rounded-md border border-input bg-transparent px-2 py-1 text-xs" value={status} onChange={(event) => onStatusChange(event.target.value)}>
            {STATUS_FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
          </select>
        </label>
      </div>

      {runs.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
          {status ? 'No runs with this status.' : 'No runs yet. Use Run now on a schedule to try it.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border/60">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Started</th>
                <th scope="col" className="px-3 py-2 font-medium">Schedule</th>
                <th scope="col" className="px-3 py-2 font-medium">Type</th>
                <th scope="col" className="px-3 py-2 font-medium">Trigger</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Duration</th>
                <th scope="col" className="px-3 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {runs.map((run) => (
                <tr key={run.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">{formatDateTime(run.startedAt ?? run.finishedAt ?? run.scheduledFor)}</td>
                  <td className="max-w-56 truncate px-3 py-2" title={run.projectPath ?? undefined}>{run.scheduleName ?? 'Deleted schedule'}</td>
                  <td className="px-3 py-2"><KindLabel kind={run.kind} handoff={run.kind === 'script' && Boolean(run.sessionId)} /></td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{run.trigger === 'manual' ? 'Run now' : 'Schedule'}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1.5">
                      <StatusPill status={run.status} />
                      {run.repeatCount > 1 && (
                        <span className="text-xs tabular-nums text-muted-foreground" title={`${run.repeatCount} times in a row, last ${formatDateTime(run.finishedAt)}`}>×{run.repeatCount}</span>
                      )}
                    </span>
                    {run.error && <p className="mt-1 max-w-64 text-xs text-muted-foreground">{run.error}</p>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {run.status === 'running' ? 'running…' : formatDuration(run.startedAt, run.finishedAt)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <div className="flex gap-1">
                      {run.sessionId && (
                        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => navigate(`/session/${run.sessionId}`)}>
                          <MessageSquare className="mr-1 h-3.5 w-3.5" aria-hidden />Open chat
                        </Button>
                      )}
                      {(run.output || run.hasLog) && (
                        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => { void openOutput(run); }}>
                          <FileText className="mr-1 h-3.5 w-3.5" aria-hidden />Output{run.exitCode !== null ? ` (exit ${run.exitCode})` : ''}
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

      <Dialog open={viewing !== null} onOpenChange={(open) => { if (!open) setViewing(null); }}>
        <DialogContent className="max-h-[85vh] w-[min(100vw-1rem,56rem)] max-w-none overflow-hidden p-4">
          <DialogTitle className="not-sr-only mb-1 text-base font-semibold">{viewing?.scheduleName ?? 'Run'} — output</DialogTitle>
          <p className="mb-2 text-xs tabular-nums text-muted-foreground">
            {formatDateTime(viewing?.startedAt)} · {viewing && formatDuration(viewing.startedAt, viewing.finishedAt)}{viewing?.exitCode !== null && viewing?.exitCode !== undefined ? ` · exit ${viewing.exitCode}` : ''}
          </p>
          {log.loading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading the log…</p>
          ) : (
            <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-xs">{log.text || '(no output)'}</pre>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

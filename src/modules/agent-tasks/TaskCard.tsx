import { AlertCircle, Clock, Loader2 } from 'lucide-react';

import { cn, formatDateTime } from '@/shared/utils';
import type { AgentTask } from '@/shared/types';
import { attentionReasons, projectName } from '@/modules/agent-tasks/utils/agentTaskLabels';

/**
 * The summary's opening prose for a card: tables, headings and list markers
 * read badly in three clamped lines, so they are left for the detail view.
 */
function summaryPreview(summary: string): string {
  const prose: string[] = [];
  for (const raw of summary.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('|')) break;
    if (!line) {
      if (prose.length) break;
      continue;
    }
    prose.push(line.replace(/^#+\s*|^[-*]\s+|\*\*|__|`/g, ''));
  }
  return prose.join(' ');
}

type Props = {
  task: AgentTask;
  /** Shown in the all-projects view, where tasks of several agent projects mix. */
  showProject: boolean;
  onOpen: () => void;
};

/** Used by TaskBoard: one task as a card — what it is, where it stands, and whether it needs you. */
export default function TaskCard({ task, showProject, onOpen }: Props) {
  const reasons = attentionReasons(task);
  const done = task.checklist.filter((item) => item.done).length;
  const closed = task.status === 'done' || task.status === 'cancelled';
  const preview = summaryPreview(task.summary);

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group w-full rounded-lg border bg-card p-3 text-left shadow-sm transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        reasons.length ? 'border-amber-500/60' : 'border-border/70',
        closed && 'opacity-75',
      )}
    >
      <div className="flex items-start gap-2">
        <span className="mt-px shrink-0 text-xs tabular-nums text-muted-foreground">#{task.id}</span>
        <h3 className="min-w-0 flex-1 hyphens-auto break-words text-sm font-medium leading-snug" lang="cs">{task.title}</h3>
      </div>
      {task.running && (
        <p className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[11px] font-medium text-violet-700 dark:text-violet-300">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          Agent working
        </p>
      )}

      {preview ? (
        <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{preview}</p>
      ) : (
        <p className="mt-1.5 line-clamp-2 text-xs italic text-muted-foreground">{task.brief}</p>
      )}

      {reasons.length > 0 && (
        <ul className="mt-2 space-y-0.5" aria-label="Needs you">
          {reasons.map((reason) => (
            <li key={reason} className="flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300">
              <AlertCircle className="h-3 w-3 shrink-0" aria-hidden />
              {reason}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
        {task.checklist.length > 0 && <span>{done}/{task.checklist.length} steps</span>}
        {!closed && task.nextCheckAt && !task.running && (
          <span className="inline-flex items-center gap-1" title="The agent looks again at this time">
            <Clock className="h-3 w-3" aria-hidden />
            {formatDateTime(task.nextCheckAt)}
          </span>
        )}
        {task.status === 'cancelled' && <span>Cancelled</span>}
        {showProject && <span title={task.projectPath}>{projectName(task.projectPath)}</span>}
      </div>
    </button>
  );
}

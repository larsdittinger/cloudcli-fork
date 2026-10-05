import { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Bot, ChevronUp, Eye, Terminal, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { BackgroundTask } from '@/shared/types';
import { cn } from '@/shared/utils';

type BackgroundTasksTabProps = {
  tasks: BackgroundTask[];
  isInputFocused?: boolean;
};

const AGENT_TASK_TYPES = new Set(['local_agent', 'remote_agent', 'in_process_teammate']);

function iconForTask(taskType: string): LucideIcon {
  if (taskType === 'local_bash') return Terminal;
  if (taskType.startsWith('monitor')) return Eye;
  if (taskType === 'local_workflow') return Workflow;
  return Bot;
}

/**
 * Status tab for work that outlives the turn — subagents started with
 * `run_in_background`, background shells, monitors. The turn's activity
 * indicator is gone by then, so without this the session looks idle while
 * agents keep working, sometimes for hours.
 *
 * Rendered by ChatComposer in the activity indicator's slot: beside the
 * "Thinking…" tab while a turn runs, on its own once the turn is over. Opens
 * a list of what each task is doing and for how long.
 */
export default function BackgroundTasksTab({ tasks, isInputFocused = false }: BackgroundTasksTabProps) {
  const { t } = useTranslation('chat');
  // Whether the per-task list is unfolded; the tab alone only gives a count.
  const [isOpen, setIsOpen] = useState(false);
  // Wall clock for the elapsed labels, ticking only while a task has a start time.
  const [now, setNow] = useState(() => Date.now());
  const containerRef = useRef<HTMLDivElement>(null);
  const hasTimedTask = tasks.some((task) => task.startedAt);

  useEffect(() => {
    if (!hasTimedTask) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasTimedTask]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  if (tasks.length === 0) return null;

  const formatElapsed = (startedAt: number | null): string => {
    if (!startedAt) return '';
    const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return t('backgroundTasks.elapsed.hoursMinutes', { hours, minutes, defaultValue: '{{hours}}h {{minutes}}m' });
    }
    if (minutes > 0) {
      return t('claudeStatus.elapsed.minutesSeconds', { minutes, seconds, defaultValue: '{{minutes}}m {{seconds}}s' });
    }
    return t('claudeStatus.elapsed.seconds', { count: seconds, defaultValue: '{{count}}s' });
  };

  const count = tasks.length;
  const onlyAgents = tasks.every((task) => AGENT_TASK_TYPES.has(task.taskType));
  const label = onlyAgents
    ? t('backgroundTasks.agents', { count, defaultValue: count === 1 ? '{{count}} agent' : '{{count}} agents' })
    : t('backgroundTasks.tasks', { count, defaultValue: count === 1 ? '{{count}} task' : '{{count}} tasks' });
  const startTimes = tasks.map((task) => task.startedAt).filter((value): value is number => Boolean(value));
  const longestElapsed = startTimes.length > 0 ? formatElapsed(Math.min(...startTimes)) : '';

  const tabSurfaceClassName = cn(
    'inline-flex h-8 items-center rounded-b-none rounded-t-lg border border-b-0 bg-card px-3 text-xs transition-all duration-200',
    isInputFocused
      ? 'border-purple-400/40 shadow-[0_-1px_2px_hsl(var(--foreground)/0.08),1px_0_2px_hsl(var(--foreground)/0.06),-1px_0_2px_hsl(var(--foreground)/0.06)]'
      : 'border-purple-300/50 shadow-[0_-1px_1px_hsl(var(--foreground)/0.04),1px_0_1px_hsl(var(--foreground)/0.03),-1px_0_1px_hsl(var(--foreground)/0.03)] dark:border-purple-500/30',
  );

  return (
    <div ref={containerRef} className="pointer-events-auto relative">
      {isOpen && (
        <div
          role="list"
          className="absolute bottom-full left-0 z-20 mb-1.5 max-h-72 w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-border/60 bg-card p-1 shadow-lg"
        >
          {tasks.map((task) => {
            const Icon = iconForTask(task.taskType);
            const details = [
              task.activity,
              task.toolUses
                ? t('backgroundTasks.toolUses', {
                  count: task.toolUses,
                  defaultValue: task.toolUses === 1 ? '{{count}} tool' : '{{count}} tools',
                })
                : null,
              task.subagentType,
            ].filter(Boolean).join(' · ');

            return (
              <div key={task.taskId} role="listitem" className="flex items-start gap-2 rounded-md px-2 py-1.5">
                <Icon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-purple-500 dark:text-purple-400" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">
                    {task.description || task.taskType}
                  </div>
                  {details && <div className="truncate text-[11px] text-muted-foreground">{details}</div>}
                </div>
                <span className="flex-shrink-0 pt-px text-[11px] tabular-nums text-muted-foreground/70">
                  {formatElapsed(task.startedAt)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((previous) => !previous)}
        title={t('backgroundTasks.title', { defaultValue: 'Still running in the background after the reply' })}
        className={cn(tabSurfaceClassName, 'gap-2 text-purple-700 hover:text-purple-900 dark:text-purple-300 dark:hover:text-purple-200')}
      >
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400" aria-hidden />
        <span className="font-medium">
          {label}
          <span className="hidden sm:inline">{` ${t('backgroundTasks.suffix', { defaultValue: 'in background' })}`}</span>
        </span>
        {longestElapsed && <span className="tabular-nums text-muted-foreground/60">{longestElapsed}</span>}
        <ChevronUp className={cn('h-3 w-3 transition-transform duration-150', !isOpen && 'rotate-180')} aria-hidden />
      </button>
    </div>
  );
}

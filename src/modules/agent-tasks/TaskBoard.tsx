import { useMemo, useState } from 'react';
import { CheckCheck, CheckSquare, MoreHorizontal, Trash2 } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { useMultiSelect } from '@/shared/hooks/useMultiSelect';
import { ActionMenu, BulkActionBar, Pill, PillBar } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { AgentTask } from '@/shared/types';
import TaskCard from '@/modules/agent-tasks/TaskCard';
import { BOARD_COLUMNS } from '@/modules/agent-tasks/utils/agentTaskLabels';

type Props = {
  tasks: AgentTask[];
  showProject: boolean;
  onOpen: (task: AgentTask) => void;
  /** The board's project, so "Mark all as read" stays within it; null on the all-projects board. */
  projectPath: string | null;
  /** Refetches the board after a bulk action. */
  onChanged: () => Promise<void> | void;
};

/** Newest activity first; questions by when they were asked, closed tasks by when they closed. */
function sortForColumn(columnId: string, tasks: AgentTask[]): AgentTask[] {
  const key = (task: AgentTask) =>
    columnId === 'waiting_owner' ? (task.question?.askedAt ?? task.updatedAt)
      : columnId === 'closed' ? (task.closedAt ?? task.updatedAt)
        : task.updatedAt;
  return [...tasks].sort((a, b) => key(b).localeCompare(key(a)) || b.id - a.id);
}

/**
 * Used by AgentTasksPanel: the five columns of the board. Wide screens show
 * them side by side; narrow ones show one column at a time with a switcher,
 * so nothing ever scrolls sideways.
 */
export default function TaskBoard({ tasks, showProject, onOpen, projectPath, onChanged }: Props) {
  const columns = useMemo(
    () => BOARD_COLUMNS.map((column) => ({
      ...column,
      tasks: sortForColumn(column.id, tasks.filter((task) => column.statuses.includes(task.status))),
    })),
    [tasks],
  );
  const firstUseful = columns.find((column) => column.id === 'waiting_owner' && column.tasks.length)
    ?? columns.find((column) => column.id !== 'closed' && column.tasks.length)
    ?? columns[1];
  // The column shown on narrow screens; null = the most useful one for the current tasks.
  const [chosen, setChosen] = useState<string | null>(null);
  const activeId = chosen ?? firstUseful.id;
  // Board order, column by column: what a Shift-click range runs over.
  const orderedIds = useMemo(() => columns.flatMap((column) => column.tasks.map((task) => task.id)), [columns]);
  const selection = useMultiSelect(orderedIds);
  // A bulk action is on its way; the bar's buttons wait for it.
  const [busy, setBusy] = useState(false);
  // Why the last bulk action failed; cleared by the next one.
  const [actionError, setActionError] = useState<string | null>(null);

  const run = async (action: () => Promise<Response>, clearSelection: boolean) => {
    setBusy(true);
    setActionError(null);
    try {
      await readApiJson(await action());
      if (clearSelection) selection.clear();
      await onChanged();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const deleteSelected = () => {
    const ids = [...selection.selected];
    // Deleting stops the task's agent and discards its drafts; it cannot be undone.
    if (!window.confirm(`Delete ${ids.length === 1 ? 'this task' : `${ids.length} tasks`}? A running agent stops and unsent drafts are discarded. This cannot be undone.`)) return;
    void run(() => api.agentTasks.removeMany(ids), true);
  };

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <ActionMenu
          label="Task actions"
          ariaLabel="Task actions"
          icon={MoreHorizontal}
          iconOnly
          variant="ghost"
          size="icon"
          className="ml-auto"
          triggerClassName="h-8 w-8 text-muted-foreground"
          menuClassName="w-[260px] rounded-xl p-1.5 shadow-xl"
          items={[
            {
              key: 'read-all',
              label: 'Mark all as read',
              description: 'Clears the badges. Questions, mandates and drafts still wait for you.',
              icon: CheckCheck,
              onSelect: () => { void run(() => api.agentTasks.markRead('all', projectPath ?? undefined), false); },
            },
            { key: 'select', label: 'Select tasks', description: `Or ${selection.modifierLabel}-click and Shift-click cards.`, icon: CheckSquare, onSelect: selection.startSelecting },
          ]}
        />
      </div>
      {selection.isSelecting && (
        <BulkActionBar
          className="mb-3"
          count={selection.selected.size}
          noun={['task', 'tasks']}
          busy={busy}
          onSelectAll={selection.selectAll}
          onClear={selection.clear}
          actions={[
            { key: 'read', label: 'Mark as read', icon: CheckCheck, onSelect: () => { void run(() => api.agentTasks.markRead([...selection.selected]), true); } },
            { key: 'delete', label: 'Delete', icon: Trash2, isDanger: true, onSelect: deleteSelected },
          ]}
        />
      )}
      {actionError && <p role="alert" className="mb-2 text-sm text-red-600 dark:text-red-300">{actionError}</p>}

      <PillBar role="group" aria-label="Board column" className="mb-3 flex w-full lg:hidden">
        {columns.map((column) => (
          <Pill
            key={column.id}
            isActive={activeId === column.id}
            aria-pressed={activeId === column.id}
            onClick={() => setChosen(column.id)}
            className="min-w-0 flex-1 justify-center whitespace-nowrap px-1 text-xs sm:px-3 sm:text-sm"
          >
            {column.short}
            <span className={cn('tabular-nums', column.id === 'waiting_owner' && column.tasks.length ? 'font-semibold text-amber-600 dark:text-amber-300' : 'text-muted-foreground')}>
              {column.tasks.length}
            </span>
          </Pill>
        ))}
      </PillBar>

      <div className="grid gap-3 lg:grid-cols-5">
        {columns.map((column) => (
          <section
            key={column.id}
            aria-label={column.label}
            className={cn(
              'min-w-0 rounded-xl p-2 lg:block',
              column.id === 'waiting_owner' ? 'bg-amber-500/[0.07]' : 'bg-muted/40',
              activeId === column.id ? 'block' : 'hidden',
            )}
          >
            <header className="mb-2 hidden items-baseline justify-between px-1 lg:flex">
              <h2 className={cn('text-xs font-semibold', column.id === 'waiting_owner' && column.tasks.length ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>
                {column.label}
              </h2>
              <span className="text-xs tabular-nums text-muted-foreground">{column.tasks.length}</span>
            </header>
            <div className="space-y-2">
              {column.tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  showProject={showProject}
                  isSelecting={selection.isSelecting}
                  isPicked={selection.selected.has(task.id)}
                  onOpen={(event) => selection.handleClick(task.id, event, () => onOpen(task))}
                />
              ))}
              {column.tasks.length === 0 && (
                <p className="px-1 py-3 text-center text-xs text-muted-foreground/80">
                  {column.id === 'waiting_owner' ? 'Nothing waits for you.' : 'Empty'}
                </p>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

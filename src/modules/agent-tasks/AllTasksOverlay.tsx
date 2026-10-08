import { useState } from 'react';
import { Loader2, X } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { AgentTask, AgentTaskInput } from '@/shared/types';
import { useAgentTasks } from '@/modules/agent-tasks/hooks/useAgentTasks';
import TaskBoard from '@/modules/agent-tasks/TaskBoard';
import TaskDetail from '@/modules/agent-tasks/TaskDetail';
import TaskForm from '@/modules/agent-tasks/TaskForm';

type Props = { onClose: () => void };

/** Opened by AllTasksButton: the board of every project's agent tasks; new tasks are made in a project's tab. */
export default function AllTasksOverlay({ onClose }: Props) {
  // Whether tasks closed more than 30 days ago are listed too.
  const [includeOld, setIncludeOld] = useState(false);
  // The task whose detail is open above the board, by number.
  const [openId, setOpenId] = useState<number | null>(null);
  // The task being edited from its detail, if any.
  const [editing, setEditing] = useState<AgentTask | null>(null);
  const { tasks, loading, error, reload } = useAgentTasks(null, includeOld);

  const saveEdit = async (values: Partial<AgentTaskInput>) => {
    if (!editing) return;
    await readApiJson(await api.agentTasks.update(editing.id, values));
    await reload();
  };

  return (
    <Dialog
      open
      // Escape reaches every open dialog; while a task is open it closes only the task.
      onOpenChange={(next) => { if (!next && openId === null && editing === null) onClose(); }}
    >
      <DialogContent
        aria-label="All agent tasks"
        wrapperClassName="z-[10000]"
        className="flex h-[min(92vh,60rem)] w-[min(100vw-1rem,90rem)] max-w-none flex-col gap-3 p-4 md:p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <DialogTitle className="not-sr-only text-base font-semibold">All agent tasks</DialogTitle>
            <p className="text-sm text-muted-foreground">Every project's tasks. New tasks start in a project's Agent tasks tab.</p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{error}</p>}
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading tasks…</p>
          ) : tasks.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border/70 p-6 text-sm text-muted-foreground">No agent tasks yet.</p>
          ) : (
            <TaskBoard tasks={tasks} showProject onOpen={(task) => setOpenId(task.id)} />
          )}
          <button type="button" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setIncludeOld((value) => !value)}>
            {includeOld ? 'Hide tasks closed over 30 days ago' : 'Show older closed tasks'}
          </button>
        </div>

        {/* Keyed by task: a half-typed comment never carries over to another task. */}
        <TaskDetail
          key={openId ?? 'none'}
          taskId={openId}
          // Escape reaches the detail under the form too; only the form on top closes.
          onClose={() => { if (editing === null) setOpenId(null); }}
          onEdit={setEditing}
          onOpenChat={onClose}
          wrapperClassName="z-[10001]"
        />
        {editing && (
          <TaskForm task={editing} projectPath={editing.projectPath} onClose={() => setEditing(null)} onSubmit={saveEdit} wrapperClassName="z-[10002]" />
        )}
      </DialogContent>
    </Dialog>
  );
}

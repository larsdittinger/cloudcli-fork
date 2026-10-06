import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button, Pill, PillBar } from '@/shared/ui';
import type { AgentTask, AgentTaskInput, Project } from '@/shared/types';
import { useAgentTasks } from '@/modules/agent-tasks/hooks/useAgentTasks';
import { useAgentTasksAttention } from '@/modules/agent-tasks/hooks/useAgentTasksAttention';
import TaskBoard from '@/modules/agent-tasks/TaskBoard';
import TaskDetail from '@/modules/agent-tasks/TaskDetail';
import TaskForm from '@/modules/agent-tasks/TaskForm';

type Props = { selectedProject: Project };

/** Rendered by WorkspaceMain for the admin-only Agent tasks tab: the board of long-running tasks and their detail. */
export default function AgentTasksPanel({ selectedProject }: Props) {
  const projectPath = selectedProject.fullPath || selectedProject.path || '';
  // Board scope: this project's tasks, or every project's.
  const [scope, setScope] = useState<'project' | 'all'>('project');
  // Whether tasks closed more than 30 days ago are listed too.
  const [includeOld, setIncludeOld] = useState(false);
  // The task whose detail is open, by number (stays valid while the list refetches).
  const [openId, setOpenId] = useState<number | null>(null);
  // The form: closed, a new task, or editing one.
  const [form, setForm] = useState<{ task: AgentTask | null } | null>(null);
  const { tasks, loading, error, reload } = useAgentTasks(scope === 'project' ? projectPath : null, includeOld);
  const attention = useAgentTasksAttention();
  const elsewhere = scope === 'project' ? attention.total - (attention.byProject[projectPath] ?? 0) : 0;

  const submit = async (values: AgentTaskInput) => {
    if (form?.task) {
      await readApiJson(await api.agentTasks.update(form.task.id, values));
    } else {
      const created = await readApiJson<{ data: AgentTask }>(await api.agentTasks.create(values));
      // A task created for another project would vanish from this board; follow it.
      if (created.data.projectPath !== projectPath) setScope('all');
      setOpenId(created.data.id);
    }
    await reload();
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">Agent tasks</h1>
            <p className="text-sm text-muted-foreground">Work that takes days. Each task wakes its agent when something happens; the card is its memory.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <PillBar aria-label="Which tasks">
              <Pill isActive={scope === 'project'} aria-pressed={scope === 'project'} onClick={() => setScope('project')}>This project</Pill>
              <Pill isActive={scope === 'all'} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All projects</Pill>
            </PillBar>
            <Button size="sm" onClick={() => setForm({ task: null })}>
              <Plus className="mr-1 h-4 w-4" aria-hidden />New task
            </Button>
          </div>
        </header>

        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{error}</p>}

        {elsewhere > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            <span>{elsewhere === 1 ? 'A task in another project needs you.' : `${elsewhere} tasks in other projects need you.`}</span>
            <Button size="sm" variant="outline" onClick={() => setScope('all')}>Show all projects</Button>
          </div>
        )}

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading tasks…</p>
        ) : tasks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 p-6 text-sm">
            <p className="font-medium">No tasks {scope === 'project' ? 'in this project' : 'yet'}.</p>
            <p className="mt-1 max-w-2xl text-muted-foreground">
              Create one here, or tell an agent in a chat — e.g. “find a printer for our labels, ask for prices and recommend one”.
              It sets up the task, mails suppliers when you allow it, and wakes up whenever someone replies.
            </p>
          </div>
        ) : (
          <TaskBoard tasks={tasks} showProject={scope === 'all'} onOpen={(task) => setOpenId(task.id)} />
        )}

        <div>
          <button type="button" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setIncludeOld((value) => !value)}>
            {includeOld ? 'Hide tasks closed over 30 days ago' : 'Show older closed tasks'}
          </button>
        </div>
      </div>

      <TaskDetail taskId={openId} onClose={() => setOpenId(null)} onEdit={(task) => setForm({ task })} />
      {form && <TaskForm task={form.task} projectPath={projectPath} onClose={() => setForm(null)} onSubmit={submit} />}
    </div>
  );
}

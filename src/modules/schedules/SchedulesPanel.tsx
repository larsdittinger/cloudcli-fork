import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button, Pill, PillBar } from '@/shared/ui';
import type { Project, Schedule, ScheduleInput } from '@/shared/types';
import { useScheduleProposals } from '@/modules/schedules/hooks/useScheduleProposals';
import { useSchedules } from '@/modules/schedules/hooks/useSchedules';
import RunsTable from '@/modules/schedules/RunsTable';
import ScheduleCard from '@/modules/schedules/ScheduleCard';
import ScheduleForm from '@/modules/schedules/ScheduleForm';

type Props = { selectedProject: Project };

/** Rendered by WorkspaceMain for the admin-only Schedules tab: schedules on top, run history below. */
export default function SchedulesPanel({ selectedProject }: Props) {
  const projectPath = selectedProject.fullPath || selectedProject.path || '';
  const [scope, setScope] = useState<'project' | 'all'>('project');
  const [runStatus, setRunStatus] = useState('');
  const [editing, setEditing] = useState<{ open: boolean; schedule: Schedule | null }>({ open: false, schedule: null });
  const { schedules, runs, loading, error, reload } = useSchedules(scope === 'project' ? projectPath : null, runStatus);
  const proposalSummary = useScheduleProposals();
  const elsewhere = scope === 'project' ? proposalSummary.proposals - (proposalSummary.byProject[projectPath] ?? 0) : 0;

  const proposals = schedules.filter((schedule) => schedule.proposal);
  const ordered = [...proposals, ...schedules.filter((schedule) => !schedule.proposal)];

  const submit = async (values: ScheduleInput) => {
    if (editing.schedule) {
      await readApiJson(await api.schedules.update(editing.schedule.id, values));
    } else {
      await readApiJson(await api.schedules.create(values));
    }
    await reload();
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">Schedules</h1>
            <p className="text-sm text-muted-foreground">AI prompts and scripts that run on their own. AI runs open as chats in the sidebar.</p>
          </div>
          <div className="flex items-center gap-2">
            <PillBar aria-label="Which schedules">
              <Pill isActive={scope === 'project'} aria-pressed={scope === 'project'} onClick={() => setScope('project')}>This project</Pill>
              <Pill isActive={scope === 'all'} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All projects</Pill>
            </PillBar>
            <Button size="sm" onClick={() => setEditing({ open: true, schedule: null })}>
              <Plus className="mr-1 h-4 w-4" aria-hidden />New schedule
            </Button>
          </div>
        </header>

        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{error}</p>}

        {elsewhere > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            <span>{elsewhere === 1 ? '1 proposal waits in another project.' : `${elsewhere} proposals wait in other projects.`}</span>
            <Button size="sm" variant="outline" onClick={() => setScope('all')}>Show all projects</Button>
          </div>
        )}

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading schedules…</p>
        ) : ordered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 p-6 text-sm">
            <p className="font-medium">No schedules {scope === 'project' ? 'in this project' : 'yet'}.</p>
            <p className="mt-1 text-muted-foreground">
              Create one here, or ask an agent in a chat — e.g. “every weekday at 8 check new orders and summarise them”. The agent proposes it and you approve it here.
            </p>
          </div>
        ) : (
          <section aria-label="Schedules" className="space-y-2">
            {proposals.length > 0 && (
              <p className="text-sm text-amber-800 dark:text-amber-200">
                {proposals.length === 1 ? 'An agent proposed a schedule.' : `Agents proposed ${proposals.length} schedules.`} Review and approve below.
              </p>
            )}
            {ordered.map((schedule) => (
              <ScheduleCard
                key={schedule.id}
                schedule={schedule}
                showProject={scope === 'all'}
                onEdit={() => setEditing({ open: true, schedule })}
                onChanged={() => { void reload(); }}
              />
            ))}
          </section>
        )}

        <RunsTable runs={runs} status={runStatus} onStatusChange={setRunStatus} />
      </div>

      {editing.open && (
        <ScheduleForm
          open={editing.open}
          schedule={editing.schedule}
          projectPath={projectPath}
          onOpenChange={(open) => setEditing((current) => ({ ...current, open }))}
          onSubmit={submit}
        />
      )}
    </div>
  );
}

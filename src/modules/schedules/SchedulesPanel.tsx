import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { Button, Pill, PillBar, SettingSwitch } from '@/shared/ui';
import type { Project, Schedule, ScheduleInput } from '@/shared/types';
import { useScheduleProposals } from '@/modules/schedules/hooks/useScheduleProposals';
import { useSchedules } from '@/modules/schedules/hooks/useSchedules';
import RunsTable from '@/modules/schedules/RunsTable';
import ScheduleCard from '@/modules/schedules/ScheduleCard';
import ScheduleForm from '@/modules/schedules/ScheduleForm';

type Props = { selectedProject: Project };

const loadAutoApprove = async () => (await readApiJson<{ data: { agentsAutoApprove: boolean } }>(await api.schedules.settings())).data.agentsAutoApprove;
const saveAutoApprove = async (value: boolean) => (await readApiJson<{ data: { agentsAutoApprove: boolean } }>(await api.schedules.saveSettings({ agentsAutoApprove: value }))).data.agentsAutoApprove;

/** Rendered by WorkspaceMain for the admin-only Schedules tab: schedules on top, run history below. */
export default function SchedulesPanel({ selectedProject }: Props) {
  const { t } = useTranslation('schedules');
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
            <h1 className="text-lg font-semibold">{t('panel.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('panel.description')}</p>
          </div>
          <div className="flex items-center gap-2">
            <PillBar aria-label={t('panel.scopeLabel')}>
              <Pill isActive={scope === 'project'} aria-pressed={scope === 'project'} onClick={() => setScope('project')}>{t('panel.thisProject')}</Pill>
              <Pill isActive={scope === 'all'} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>{t('panel.allProjects')}</Pill>
            </PillBar>
            <Button size="sm" onClick={() => setEditing({ open: true, schedule: null })}>
              <Plus className="mr-1 h-4 w-4" aria-hidden />{t('panel.newSchedule')}
            </Button>
          </div>
        </header>

        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{error}</p>}

        <SettingSwitch
          label={t('panel.autoApproveLabel')}
          description={t('panel.autoApproveDescription')}
          load={loadAutoApprove}
          save={saveAutoApprove}
        />

        {elsewhere > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            <span>{t('panel.proposalsElsewhere', { count: elsewhere })}</span>
            <Button size="sm" variant="outline" onClick={() => setScope('all')}>{t('panel.showAllProjects')}</Button>
          </div>
        )}

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t('panel.loading')}</p>
        ) : ordered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 p-6 text-sm">
            <p className="font-medium">{t(scope === 'project' ? 'panel.emptyProject' : 'panel.emptyAll')}</p>
            <p className="mt-1 text-muted-foreground">{t('panel.emptyHint')}</p>
          </div>
        ) : (
          <section aria-label={t('panel.listLabel')} className="space-y-2">
            {proposals.length > 0 && (
              <p className="text-sm text-amber-800 dark:text-amber-200">
                {t('panel.proposed', { count: proposals.length })} {t('panel.reviewBelow')}
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

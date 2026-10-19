import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, DialogContent, DialogTitle, Input } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { AgentTask, AgentTaskInput } from '@/shared/types';
import { validateTaskForm } from '@/modules/agent-tasks/utils/agentTaskLabels';

type Props = {
  /** The task being edited, or null for a new one. */
  task: AgentTask | null;
  /** Agent project a new task runs in by default (the open project). */
  projectPath: string;
  onClose: () => void;
  /** New task: every field. Edit: only the fields that changed (a rename must not re-send the mandate). */
  onSubmit: (values: Partial<AgentTaskInput>) => Promise<void>;
  /** Lifts the dialog above another one it opens from (the all-tasks overlay). */
  wrapperClassName?: string;
};

const FIELD_CLASS =
  'w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1 text-sm">
      <label htmlFor={id} className="block font-medium">{label}</label>
      {children(id)}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Used by AgentTasksPanel to create a task or edit its brief, mandate and agent. */
export default function TaskForm({ task, projectPath, onClose, onSubmit, wrapperClassName }: Props) {
  const { t } = useTranslation('agentTasks');
  // The form's values; starts from the edited task or sensible defaults.
  const [values, setValues] = useState<AgentTaskInput>({
    title: task?.title ?? '',
    brief: task?.brief ?? '',
    mandate: task?.mandate ?? '',
    projectPath: task?.projectPath ?? projectPath,
    provider: task?.provider ?? 'claude',
    model: task?.model ?? null,
    effort: task?.effort ?? null,
    permissionMode: task?.permissionMode ?? 'bypassPermissions',
  });
  // Validation or server error shown above the buttons.
  const [error, setError] = useState<string | null>(null);
  // True while the save request runs.
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof AgentTaskInput>(key: K, value: AgentTaskInput[K]) => setValues((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    const problem = validateTaskForm(values, t);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const cleaned: AgentTaskInput = {
        ...values,
        title: values.title.trim(),
        brief: values.brief.trim(),
        mandate: values.mandate.trim(),
        projectPath: values.projectPath.trim(),
        model: values.model?.trim() || null,
        effort: values.effort?.trim() || null,
      };
      if (task) {
        const changed = (Object.keys(cleaned) as Array<keyof AgentTaskInput>).filter((key) => cleaned[key] !== task[key]);
        if (changed.length) await onSubmit(Object.fromEntries(changed.map((key) => [key, cleaned[key]])) as Partial<AgentTaskInput>);
      } else {
        await onSubmit(cleaned);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent wrapperClassName={wrapperClassName} className="max-h-[92vh] w-[min(100vw-1rem,42rem)] max-w-none overflow-y-auto p-4 md:p-5">
        <DialogTitle className="not-sr-only mb-1 text-base font-semibold">{task ? t('form.editTitle', { id: task.id }) : t('form.newTitle')}</DialogTitle>
        <p className="mb-4 text-sm text-muted-foreground">
          {t(task ? 'form.editIntro' : 'form.newIntro')}
        </p>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field label={t('form.title')}>
            {(id) => <Input id={id} value={values.title} onChange={(event) => set('title', event.target.value)} placeholder={t('form.titlePlaceholder')} maxLength={200} />}
          </Field>
          <Field label={t('form.brief')} hint={t('form.briefHint')}>
            {(id) => (
              <textarea
                id={id}
                className={cn(FIELD_CLASS, 'min-h-32')}
                value={values.brief}
                onChange={(event) => set('brief', event.target.value)}
                placeholder={t('form.briefPlaceholder')}
              />
            )}
          </Field>
          <Field label={t('form.mandate')} hint={t('form.mandateHint')}>
            {(id) => <textarea id={id} className={cn(FIELD_CLASS, 'min-h-20')} value={values.mandate} onChange={(event) => set('mandate', event.target.value)} placeholder={t('form.mandatePlaceholder')} />}
          </Field>
          <Field label={t('form.agentProject')} hint={t('form.agentProjectHint')}>
            {(id) => <Input id={id} value={values.projectPath} onChange={(event) => set('projectPath', event.target.value)} className="font-mono text-xs" />}
          </Field>

          <details className="rounded-lg border border-border/60 p-3 text-sm">
            <summary className="cursor-pointer font-medium">{t('form.agentSettings')}</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label={t('form.provider')}>
                {(id) => (
                  <select id={id} className={FIELD_CLASS} value={values.provider} onChange={(event) => set('provider', event.target.value)}>
                    <option value="claude">Claude Code</option>
                    <option value="codex">Codex</option>
                    <option value="cursor">Cursor</option>
                    <option value="opencode">OpenCode</option>
                  </select>
                )}
              </Field>
              <Field label={t('form.model')} hint={t('form.modelHint')}>
                {(id) => <Input id={id} value={values.model ?? ''} onChange={(event) => set('model', event.target.value)} placeholder={t('form.modelPlaceholder')} />}
              </Field>
              <Field label={t('form.effort')} hint={t('form.effortHint')}>
                {(id) => <Input id={id} value={values.effort ?? ''} onChange={(event) => set('effort', event.target.value)} placeholder={t('form.effortPlaceholder')} />}
              </Field>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                {t('form.autonomousNote')}
              </p>
            </div>
          </details>

          {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>{t('form.cancel')}</Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />}
              {t(task ? 'form.save' : 'form.createAndStart')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

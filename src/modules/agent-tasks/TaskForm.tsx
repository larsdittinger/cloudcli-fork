import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

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
};

const FIELD_CLASS =
  'w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

const MANDATE_PLACEHOLDER = 'e.g. May e-mail up to 8 Czech printers asking for a quote and answer their questions. Must not order, pay or promise anything.';

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
export default function TaskForm({ task, projectPath, onClose, onSubmit }: Props) {
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
    const problem = validateTaskForm(values);
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
      <DialogContent className="max-h-[92vh] w-[min(100vw-1rem,42rem)] max-w-none overflow-y-auto p-4 md:p-5">
        <DialogTitle className="not-sr-only mb-1 text-base font-semibold">{task ? `Edit task #${task.id}` : 'New agent task'}</DialogTitle>
        <p className="mb-4 text-sm text-muted-foreground">
          {task
            ? 'The agent sees your changes on its next wake-up; changing the brief or mandate wakes it now.'
            : 'For work that takes days. The agent works step by step, keeps the card up to date and asks you when it needs a decision.'}
        </p>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field label="Title">
            {(id) => <Input id={id} value={values.title} onChange={(event) => set('title', event.target.value)} placeholder="Label printer: three quotes" maxLength={200} />}
          </Field>
          <Field label="What should the agent achieve?" hint="Goal, what done looks like, deadlines and anything it must know.">
            {(id) => (
              <textarea
                id={id}
                className={cn(FIELD_CLASS, 'min-h-32')}
                value={values.brief}
                onChange={(event) => set('brief', event.target.value)}
                placeholder="Find a printer for our 50×30 mm labels (matte, 4 designs), get prices for 1 000 and 5 000 pcs incl. delivery, compare them and recommend one."
              />
            )}
          </Field>
          <Field label="What may it do on its own?" hint="The mandate. Anything outside it, the agent asks you first. Orders and payments always need you.">
            {(id) => <textarea id={id} className={cn(FIELD_CLASS, 'min-h-20')} value={values.mandate} onChange={(event) => set('mandate', event.target.value)} placeholder={MANDATE_PLACEHOLDER} />}
          </Field>
          <Field label="Agent project" hint="The project whose agent runs the task — its AGENTS.md, subagents and MCP servers.">
            {(id) => <Input id={id} value={values.projectPath} onChange={(event) => set('projectPath', event.target.value)} className="font-mono text-xs" />}
          </Field>

          <details className="rounded-lg border border-border/60 p-3 text-sm">
            <summary className="cursor-pointer font-medium">Agent settings</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Provider">
                {(id) => (
                  <select id={id} className={FIELD_CLASS} value={values.provider} onChange={(event) => set('provider', event.target.value)}>
                    <option value="claude">Claude Code</option>
                    <option value="codex">Codex</option>
                    <option value="cursor">Cursor</option>
                    <option value="opencode">OpenCode</option>
                  </select>
                )}
              </Field>
              <Field label="Model" hint="Empty = provider default.">
                {(id) => <Input id={id} value={values.model ?? ''} onChange={(event) => set('model', event.target.value)} placeholder="e.g. opus" />}
              </Field>
              <Field label="Effort" hint="Empty = default.">
                {(id) => <Input id={id} value={values.effort ?? ''} onChange={(event) => set('effort', event.target.value)} placeholder="e.g. high" />}
              </Field>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                Runs are autonomous: nobody sits at the chat to approve tool calls. What the agent may do is set by the mandate above.
              </p>
            </div>
          </details>

          {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />}
              {task ? 'Save' : 'Create and start'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

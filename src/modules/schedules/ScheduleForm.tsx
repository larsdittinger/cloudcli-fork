import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '@/shared/ui';
import type { Schedule, ScheduleInput, ScheduleSpec } from '@/shared/types';
import { cn, formatDateTime } from '@/shared/utils';
import { describeSchedule } from '@/modules/schedules/utils/scheduleFormat';

type Props = {
  open: boolean;
  schedule: Schedule | null;
  /** Project a new schedule belongs to; an edited schedule keeps its own. */
  projectPath: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: ScheduleInput) => Promise<void>;
};

type RepeatType = ScheduleSpec['type'];

const FIELD_CLASS =
  'w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

const REPEAT_OPTIONS: Array<{ value: RepeatType; label: string }> = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'interval', label: 'Interval' },
  { value: 'once', label: 'Once' },
  { value: 'cron', label: 'Cron' },
];

const WEEKDAYS = [
  { value: 1, short: 'Mon' }, { value: 2, short: 'Tue' }, { value: 3, short: 'Wed' }, { value: 4, short: 'Thu' },
  { value: 5, short: 'Fri' }, { value: 6, short: 'Sat' }, { value: 7, short: 'Sun' },
];

const DEFAULT_HANDOFF_HINT = 'Default: "Naplánovaná úloha … spustila skript … Zpracuj ho." followed by the output. Use {{output}} to place it yourself.';

type FormState = {
  name: string;
  kind: 'prompt' | 'script';
  repeat: RepeatType;
  time: string;
  days: number[];
  monthDay: string;
  every: string;
  unit: 'minutes' | 'hours';
  onceAt: string;
  cron: string;
  prompt: string;
  provider: string;
  model: string;
  effort: string;
  permissionMode: string;
  sessionMode: 'new' | 'continue';
  command: string;
  timeoutMinutes: string;
  handoff: boolean;
  enabled: boolean;
};

/** `datetime-local` works in the browser's zone; the app's users are in Prague, so that is the zone it means. */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toForm(schedule: Schedule | null): FormState {
  const spec = schedule?.schedule;
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  tomorrow.setHours(8, 0, 0, 0);
  return {
    name: schedule?.name ?? '',
    kind: schedule?.kind ?? 'prompt',
    repeat: spec?.type ?? 'daily',
    time: spec && 'time' in spec ? spec.time : '08:00',
    days: spec?.type === 'weekly' ? spec.days : [],
    monthDay: spec?.type === 'monthly' ? String(spec.day) : '1',
    every: spec?.type === 'interval' ? String(spec.every) : '15',
    unit: spec?.type === 'interval' ? spec.unit : 'minutes',
    onceAt: toLocalInput(spec?.type === 'once' ? spec.at : tomorrow.toISOString()),
    cron: spec?.type === 'cron' ? spec.expression : '0 8 * * 1-5',
    prompt: schedule?.prompt ?? '',
    provider: schedule?.provider ?? 'claude',
    model: schedule?.model ?? '',
    effort: schedule?.effort ?? '',
    permissionMode: schedule?.permissionMode ?? 'bypassPermissions',
    sessionMode: schedule?.sessionMode ?? 'new',
    command: schedule?.command ?? '',
    timeoutMinutes: String(Math.round((schedule?.timeoutSec ?? 1800) / 60)),
    handoff: schedule?.handoff === 'on_output',
    enabled: schedule?.enabled ?? true,
  };
}

function toSpec(form: FormState): ScheduleSpec {
  switch (form.repeat) {
    case 'daily':
      return { type: 'daily', time: form.time.trim() };
    case 'weekly':
      return { type: 'weekly', days: [...form.days].sort((a, b) => a - b), time: form.time.trim() };
    case 'monthly':
      return { type: 'monthly', day: form.monthDay === 'last' ? 'last' : Number(form.monthDay), time: form.time.trim() };
    case 'interval':
      return { type: 'interval', every: Number(form.every), unit: form.unit };
    case 'once':
      return { type: 'once', at: new Date(form.onceAt).toISOString() };
    case 'cron':
      return { type: 'cron', expression: form.cron.trim() };
  }
}

/** The first thing the form would refuse, in the words the person needs to fix it. */
function validate(form: FormState, original: FormState | null): string | null {
  if (!form.name.trim()) return 'Give the schedule a name.';
  if (form.kind === 'prompt' && !form.prompt.trim()) return 'Write the prompt the agent should run.';
  if (form.kind === 'script' && !form.command.trim()) return 'Enter the command to run.';
  if (['daily', 'weekly', 'monthly'].includes(form.repeat) && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(form.time.trim())) return 'Enter the time as HH:mm, e.g. 08:00 or 17:30.';
  if (form.repeat === 'weekly' && form.days.length === 0) return 'Pick at least one day of the week.';
  if (form.repeat === 'interval' && !(Number.isInteger(Number(form.every)) && Number(form.every) >= 1)) return 'The interval must be a whole number of at least 1.';
  if (form.repeat === 'once' && Number.isNaN(new Date(form.onceAt).getTime())) return 'Pick the date and time.';
  // Only a new date (or switching the job on) is checked, as on the server: a job waiting for
  // its retry keeps its original date and must stay editable.
  const onceDateTouched = !original || original.repeat !== 'once' || form.onceAt !== original.onceAt || (form.enabled && !original.enabled);
  if (form.repeat === 'once' && form.enabled && onceDateTouched && new Date(form.onceAt).getTime() <= Date.now()) {
    return 'That date is in the past. Pick a future date and time.';
  }
  if (form.kind === 'script' && !(Number(form.timeoutMinutes) >= 1)) return 'The timeout must be at least 1 minute.';
  return null;
}

function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={cn('space-y-1 text-sm', className)}>
      <label htmlFor={id} className="block font-medium">{label}</label>
      {children(id)}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-lg bg-muted/60 p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-md px-3 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            option.value === value ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function WeekdayPicker({ days, onChange }: { days: number[]; onChange: (days: number[]) => void }) {
  const toggle = (day: number) => onChange(days.includes(day) ? days.filter((value) => value !== day) : [...days, day]);
  return (
    <div className="space-y-1.5">
      <div role="group" aria-label="Days of the week" className="flex flex-wrap gap-1.5">
        {WEEKDAYS.map((day) => {
          const active = days.includes(day.value);
          return (
            <button
              key={day.value}
              type="button"
              aria-pressed={active}
              onClick={() => toggle(day.value)}
              className={cn(
                'h-8 w-11 rounded-md border text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                active ? 'border-primary bg-primary text-primary-foreground' : 'border-input text-muted-foreground hover:text-foreground',
                day.value >= 6 && !active && 'bg-muted/40',
              )}
            >
              {day.short}
            </button>
          );
        })}
      </div>
      <div className="flex gap-3 text-xs">
        <button type="button" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => onChange([1, 2, 3, 4, 5])}>Mon–Fri</button>
        <button type="button" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => onChange([1, 2, 3, 4, 5, 6, 7])}>Every day</button>
      </div>
    </div>
  );
}

/** Live "what this means" under the schedule: the summary at once, the next runs from the server. */
function SchedulePreview({ spec, timezone }: { spec: ScheduleSpec | null; timezone: string }) {
  const [nextRuns, setNextRuns] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const key = spec ? JSON.stringify(spec) : '';

  useEffect(() => {
    if (!spec) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await api.schedules.preview({ schedule: spec, timezone });
        const data = await readApiJson<{ data: { nextRuns: string[] } }>(response);
        if (!cancelled) {
          setNextRuns(data.data.nextRuns);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setNextRuns([]);
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `key` stands for `spec`, which is a fresh object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, timezone]);

  if (!spec) return null;
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm" aria-live="polite">
      <p className="font-medium">{describeSchedule(spec)}</p>
      {error ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-300">{error}</p>
      ) : nextRuns.length > 0 && (
        <ol className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground">
          {nextRuns.map((run, index) => (
            <li key={run}>{index === 0 ? 'Next ' : ''}{formatDateTime(run)}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Used by SchedulesPanel to create and edit a schedule; the fields follow the kind and the repeat type. */
export default function ScheduleForm({ open, schedule, projectPath, onOpenChange, onSubmit }: Props) {
  const [form, setForm] = useState<FormState>(() => toForm(schedule));
  const [original] = useState<FormState | null>(() => (schedule ? toForm(schedule) : null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));
  const targetProject = schedule?.projectPath ?? projectPath;
  const timezone = schedule?.timezone ?? 'Europe/Prague';

  const problem = validate(form, original);
  const timeValid = /^([01]?\d|2[0-3]):[0-5]\d$/.test(form.time.trim());
  const needsTime = form.repeat === 'daily' || form.repeat === 'weekly' || form.repeat === 'monthly';
  const spec = (form.repeat === 'weekly' && form.days.length === 0) || (needsTime && !timeValid) ? null : (() => {
    try {
      return toSpec(form);
    } catch {
      return null;
    }
  })();
  const usesAgent = form.kind === 'prompt' || form.handoff;

  const submit = async () => {
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        name: form.name.trim(),
        projectPath: targetProject,
        kind: form.kind,
        schedule: toSpec(form),
        timezone,
        prompt: form.prompt,
        provider: form.provider,
        model: form.model.trim() || null,
        effort: form.effort.trim() || null,
        permissionMode: form.permissionMode,
        sessionMode: form.sessionMode,
        command: form.command.trim(),
        timeoutSec: Math.round(Number(form.timeoutMinutes) * 60),
        handoff: form.kind === 'script' && form.handoff ? 'on_output' : 'none',
        enabled: form.enabled,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[min(100vw-1rem,44rem)] max-w-none overflow-y-auto p-4 md:p-5">
        <DialogTitle className="not-sr-only mb-1 text-base font-semibold">{schedule ? `Edit “${schedule.name}”` : 'New schedule'}</DialogTitle>
        <p className="mb-4 truncate text-xs text-muted-foreground" title={targetProject}>Runs in {targetProject}</p>

        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Name">{(id) => <Input id={id} value={form.name} onChange={(event) => set('name', event.target.value)} placeholder="Morning order check" />}</Field>
            <Segmented label="Kind" value={form.kind} onChange={(value) => set('kind', value)} options={[{ value: 'prompt', label: 'AI prompt' }, { value: 'script', label: 'Script' }]} />
          </div>

          <section className="space-y-3" aria-label="When it runs">
            <Segmented label="Repeats" value={form.repeat} onChange={(value) => set('repeat', value)} options={REPEAT_OPTIONS} />

            {form.repeat === 'weekly' && <WeekdayPicker days={form.days} onChange={(days) => set('days', days)} />}

            <div className="flex flex-wrap gap-3">
              {form.repeat === 'monthly' && (
                <Field label="Day of the month" className="w-44">
                  {(id) => (
                    <select id={id} className={FIELD_CLASS} value={form.monthDay} onChange={(event) => set('monthDay', event.target.value)}>
                      {Array.from({ length: 31 }, (_, index) => String(index + 1)).map((day) => <option key={day} value={day}>{day}.</option>)}
                      <option value="last">Last day</option>
                    </select>
                  )}
                </Field>
              )}
              {(form.repeat === 'daily' || form.repeat === 'weekly' || form.repeat === 'monthly') && (
                <Field label="Time" className="w-40" hint={`24 h, ${timezone}`}>
                  {(id) => <Input id={id} inputMode="numeric" maxLength={5} placeholder="08:00" value={form.time} onChange={(event) => set('time', event.target.value)} className="tabular-nums" />}
                </Field>
              )}
              {form.repeat === 'interval' && (
                <>
                  <Field label="Every" className="w-28">{(id) => <Input id={id} type="number" min={1} value={form.every} onChange={(event) => set('every', event.target.value)} />}</Field>
                  <Field label="Unit" className="w-36">
                    {(id) => (
                      <select id={id} className={FIELD_CLASS} value={form.unit} onChange={(event) => set('unit', event.target.value as FormState['unit'])}>
                        <option value="minutes">minutes</option>
                        <option value="hours">hours</option>
                      </select>
                    )}
                  </Field>
                </>
              )}
              {form.repeat === 'once' && (
                <Field label="Date and time" className="w-56">{(id) => <Input id={id} type="datetime-local" value={form.onceAt} onChange={(event) => set('onceAt', event.target.value)} />}</Field>
              )}
              {form.repeat === 'cron' && (
                <Field label="Cron expression" className="w-full" hint="minute hour day-of-month month day-of-week, in Prague time. 0 8 * * 1-5 = weekdays at 08:00.">
                  {(id) => <Input id={id} value={form.cron} onChange={(event) => set('cron', event.target.value)} className="font-mono" />}
                </Field>
              )}
            </div>

            <SchedulePreview spec={spec} timezone={timezone} />
          </section>

          {form.kind === 'prompt' ? (
            <Field label="Prompt" hint="Runs as a new chat in the sidebar each time — open it from the run history.">
              {(id) => <textarea id={id} className={cn(FIELD_CLASS, 'min-h-28')} value={form.prompt} onChange={(event) => set('prompt', event.target.value)} placeholder="Check yesterday's orders and summarise anything unusual." />}
            </Field>
          ) : (
            <section className="space-y-3">
              <Field label="Command" hint={<>Runs with <code>bash -lc</code> in the project directory. Commit the script to the project so it is clear what runs.</>}>
                {(id) => <Input id={id} value={form.command} onChange={(event) => set('command', event.target.value)} placeholder="./scripts/check_mail.py --since 1h" className="font-mono" />}
              </Field>
              <Field label="Timeout (minutes)" className="w-40">
                {(id) => <Input id={id} type="number" min={1} value={form.timeoutMinutes} onChange={(event) => set('timeoutMinutes', event.target.value)} />}
              </Field>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5" checked={form.handoff} onChange={(event) => set('handoff', event.target.checked)} />
                <span>
                  Hand the output to an agent
                  <span className="block text-xs text-muted-foreground">When the script succeeds and prints something, an AI chat starts with that output. Nothing printed, no chat.</span>
                </span>
              </label>
              {form.handoff && (
                <Field label="Hand-off prompt" hint={DEFAULT_HANDOFF_HINT}>
                  {(id) => <textarea id={id} className={cn(FIELD_CLASS, 'min-h-24')} value={form.prompt} onChange={(event) => set('prompt', event.target.value)} placeholder="Reply to these e-mails as drafts: {{output}}" />}
                </Field>
              )}
            </section>
          )}

          {usesAgent && (
            <section className="grid gap-3 sm:grid-cols-2" aria-label="Agent">
              <Field label="Provider">
                {(id) => (
                  <select id={id} className={FIELD_CLASS} value={form.provider} onChange={(event) => set('provider', event.target.value)}>
                    <option value="claude">Claude Code</option>
                    <option value="codex">Codex</option>
                    <option value="cursor">Cursor</option>
                    <option value="opencode">OpenCode</option>
                  </select>
                )}
              </Field>
              <Field label="Model" hint="Empty = provider default.">{(id) => <Input id={id} value={form.model} onChange={(event) => set('model', event.target.value)} placeholder="e.g. opus" />}</Field>
              <Field label="Permissions">
                {(id) => (
                  <select id={id} className={FIELD_CLASS} value={form.permissionMode} onChange={(event) => set('permissionMode', event.target.value)}>
                    <option value="bypassPermissions">Autonomous (nobody approves tool calls)</option>
                    <option value="acceptEdits">Accept edits</option>
                    <option value="default">Ask in the chat (the run waits)</option>
                    <option value="plan">Plan only</option>
                  </select>
                )}
              </Field>
              <Field label="Chat">
                {(id) => (
                  <select id={id} className={FIELD_CLASS} value={form.sessionMode} onChange={(event) => set('sessionMode', event.target.value as FormState['sessionMode'])}>
                    <option value="new">New chat each run</option>
                    <option value="continue">Continue one chat (sees earlier runs)</option>
                  </select>
                )}
              </Field>
            </section>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.enabled} onChange={(event) => set('enabled', event.target.checked)} disabled={Boolean(schedule?.proposal)} />
            {schedule?.proposal ? 'Enabled after you approve the proposal' : 'Enabled'}
          </label>

          {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button onClick={submit} disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />}
              {schedule ? 'Save changes' : 'Create schedule'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

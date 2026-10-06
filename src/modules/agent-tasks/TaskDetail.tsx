import { useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle, Bot, Check, CircleUser, Cog, ExternalLink, Inbox, Loader2, Mail, Pencil, Send, Trash2, X, Zap,
} from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { cn, formatDateTime } from '@/shared/utils';
import type { AgentTask, AgentTaskEvent, AgentTaskMessage, AgentTaskStatus } from '@/shared/types';
import { useAgentTaskDetail } from '@/modules/agent-tasks/hooks/useAgentTaskDetail';
import { projectName, STATUS_LABELS } from '@/modules/agent-tasks/utils/agentTaskLabels';

type Props = {
  taskId: number | null;
  onClose: () => void;
  onEdit: (task: AgentTask) => void;
};

const FIELD_CLASS =
  'w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

const WAKE_REASONS: Record<string, string> = {
  created: 'new task',
  message: 'a message arrived',
  owner_comment: 'your comment',
  owner_answer: 'your answer',
  owner_wake: 'you woke it',
  owner_edit: 'you edited the task',
  mandate_confirmed: 'mandate confirmed',
  reopened: 'reopened',
  check: 'planned check',
  restart: 'server restart',
};

const AUTHOR_STYLE: Record<AgentTaskEvent['author'], { label: string; icon: typeof Bot; className: string }> = {
  owner: { label: 'You', icon: CircleUser, className: 'text-sky-600 dark:text-sky-300' },
  agent: { label: 'Agent', icon: Bot, className: 'text-violet-600 dark:text-violet-300' },
  system: { label: 'System', icon: Cog, className: 'text-muted-foreground' },
  external: { label: 'Incoming', icon: Inbox, className: 'text-emerald-600 dark:text-emerald-300' },
};

const LONG_EVENT = 600;

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" aria-label="Close" onClick={onClose} className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
      <X className="h-4 w-4" aria-hidden />
    </button>
  );
}

function Section({ title, children, tone }: { title: string; children: ReactNode; tone?: 'attention' }) {
  return (
    <section
      aria-label={title}
      className={cn('rounded-lg border p-3', tone === 'attention' ? 'border-amber-500/50 bg-amber-500/[0.06]' : 'border-border/60')}
    >
      <h3 className={cn('mb-2 text-xs font-semibold', tone === 'attention' ? 'text-amber-800 dark:text-amber-200' : 'text-muted-foreground')}>{title}</h3>
      {children}
    </section>
  );
}

function wakeText(event: AgentTaskEvent): string {
  const reasons = event.text.replace(/^Woke up: /, '').replace(/\.$/, '').split(', ');
  return `Woke up — ${reasons.map((reason) => WAKE_REASONS[reason] ?? reason).join(', ')}`;
}

/** One diary entry; long ones fold so a supplier's e-mail does not push everything else away. */
function DiaryEntry({ event, onOpenChat }: { event: AgentTaskEvent; onOpenChat: (sessionId: string) => void }) {
  // Whether a long entry is unfolded.
  const [expanded, setExpanded] = useState(false);
  const style = AUTHOR_STYLE[event.author] ?? AUTHOR_STYLE.system;
  const Icon = event.kind === 'message_in' || event.kind === 'message_out' ? Mail : event.kind === 'wake' ? Zap : style.icon;
  const text = event.kind === 'wake' ? wakeText(event) : event.text;
  const long = text.length > LONG_EVENT;

  return (
    <li className="flex gap-2.5 py-2">
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', style.className)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className={cn('font-medium', style.className)}>{style.label}</span>
          <span className="tabular-nums text-muted-foreground">{formatDateTime(event.at)}</span>
          {event.sessionId && (
            <button type="button" className="inline-flex items-center gap-0.5 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => onOpenChat(event.sessionId as string)}>
              Open chat <ExternalLink className="h-3 w-3" aria-hidden />
            </button>
          )}
        </div>
        <p className={cn('mt-0.5 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]', event.kind === 'wake' && 'text-muted-foreground', !expanded && long && 'line-clamp-6')}>
          {text}
        </p>
        {long && (
          <button type="button" className="mt-0.5 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Show less' : 'Show all'}
          </button>
        )}
      </div>
    </li>
  );
}

function MessageDraft({ message, onDone }: { message: AgentTaskMessage; onDone: () => void }) {
  // Which button is waiting for the server.
  const [busy, setBusy] = useState<'send' | 'discard' | null>(null);
  // Failure of the last send/discard.
  const [error, setError] = useState<string | null>(null);

  const act = async (kind: 'send' | 'discard') => {
    setBusy(kind);
    setError(null);
    try {
      await readApiJson(await (kind === 'send' ? api.channels.approveOutbox(message.id) : api.channels.discardOutbox(message.id)));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="rounded-md border border-border/60 bg-background/70 p-2.5">
      <p className="text-xs text-muted-foreground">
        To <span className="font-medium text-foreground">{message.to}</span>
        {message.subject && <> · {message.subject}</>}
        {message.status === 'failed' && <span className="text-red-600 dark:text-red-300"> · failed{message.statusDetail ? `: ${message.statusDetail}` : ''}</span>}
      </p>
      <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{message.text}</p>
      {error && <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-300">{error}</p>}
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={() => void act('send')} disabled={busy !== null}>
          {busy === 'send' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Send className="mr-1 h-3.5 w-3.5" aria-hidden />}
          {message.status === 'failed' ? 'Send again' : 'Send'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => void act('discard')} disabled={busy !== null}>Discard</Button>
      </div>
    </li>
  );
}

/**
 * Used by AgentTasksPanel: everything about one task — the question waiting
 * for you, the mandate, drafts to approve, the agent's summary, the plan and
 * the diary — and the ways to steer it.
 */
export default function TaskDetail({ taskId, onClose, onEdit }: Props) {
  const navigate = useNavigate();
  const { detail, error, reload } = useAgentTaskDetail(taskId);
  // Free-text answer to the open question, or a comment when there is none.
  const [answerText, setAnswerText] = useState('');
  // Message to the agent typed in the composer at the bottom.
  const [comment, setComment] = useState('');
  // The action waiting for the server, to disable buttons and show a spinner.
  const [busy, setBusy] = useState<string | null>(null);
  // Failure of the last action.
  const [actionError, setActionError] = useState<string | null>(null);

  const task = detail?.task ?? null;
  const closed = task ? task.status === 'done' || task.status === 'cancelled' : false;
  const drafts = (detail?.messages ?? []).filter((message) => message.status === 'draft' || message.status === 'failed');
  const sent = (detail?.messages ?? []).filter((message) => message.status === 'sent');
  const events = [...(detail?.events ?? [])].reverse();

  const act = async (kind: string, request: () => Promise<Response>, after?: () => void) => {
    setBusy(kind);
    setActionError(null);
    try {
      await readApiJson(await request());
      after?.();
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const openChat = (sessionId: string) => {
    onClose();
    navigate(`/session/${sessionId}`);
  };

  const spinner = (kind: string) => busy === kind && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />;

  return (
    <Dialog open={taskId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[94vh] w-[min(100vw-1rem,52rem)] max-w-none overflow-y-auto p-0">
        {!task ? (
          <div className="relative p-5">
            <CloseButton onClose={onClose} />
            <DialogTitle className="not-sr-only text-base font-semibold">Task #{taskId}</DialogTitle>
            {error ? <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-300">{error}</p> : (
              <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</p>
            )}
          </div>
        ) : (
          <div>
            <header className="sticky top-0 z-10 rounded-t-xl border-b border-border/60 bg-popover/95 px-4 pb-3 pt-4 backdrop-blur md:px-5">
              <CloseButton onClose={onClose} />
              <div className="flex items-start gap-3 pr-8">
                <div className="min-w-0 flex-1">
                  <p className="text-xs tabular-nums text-muted-foreground">
                    #{task.id} · {projectName(task.projectPath)} · created {formatDateTime(task.createdAt)}{task.createdBy === 'agent' ? ' by an agent' : ''}
                  </p>
                  <DialogTitle className="not-sr-only mt-0.5 text-lg font-semibold leading-snug [overflow-wrap:anywhere]">{task.title}</DialogTitle>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`task-status-${task.id}`}>Status</label>
                <select
                  id={`task-status-${task.id}`}
                  className="rounded-md border border-input bg-transparent px-2 py-1 text-sm"
                  value={task.status}
                  disabled={busy !== null}
                  onChange={(event) => {
                    const next = event.target.value as AgentTaskStatus;
                    if ((next === 'done' || next === 'cancelled') && !window.confirm(
                      `Mark #${task.id} as ${STATUS_LABELS[next].toLowerCase()}? The agent stops${task.running ? ' (its current run too)' : ''} and unsent drafts are discarded.`,
                    )) return;
                    void act('status', () => api.agentTasks.setStatus(task.id, next));
                  }}
                >
                  {(Object.keys(STATUS_LABELS) as AgentTaskStatus[]).map((status) => (
                    <option key={status} value={status}>{STATUS_LABELS[status]}</option>
                  ))}
                </select>
                {task.running ? (
                  <button type="button" onClick={() => openChat(task.running?.sessionId as string)} className="inline-flex items-center gap-1 rounded-full bg-violet-500/15 px-2 py-1 text-xs font-medium text-violet-700 hover:bg-violet-500/25 dark:text-violet-300">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Agent working — open chat
                  </button>
                ) : !closed && task.nextCheckAt ? (
                  <span className="text-xs tabular-nums text-muted-foreground">Next check {formatDateTime(task.nextCheckAt)}</span>
                ) : null}
                <div className="ml-auto flex flex-wrap gap-1.5">
                  {!closed && (
                    <Button size="sm" variant="outline" disabled={busy !== null || task.running !== null} onClick={() => void act('wake', () => api.agentTasks.wake(task.id))}>
                      {spinner('wake') || <Zap className="mr-1 h-3.5 w-3.5" aria-hidden />}Wake now
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => onEdit(task)} disabled={busy !== null}>
                    <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden />Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Delete task"
                    disabled={busy !== null}
                    onClick={() => {
                      if (!window.confirm(`Delete task #${task.id} “${task.title}” with its diary? Unsent drafts are discarded.`)) return;
                      void act('delete', () => api.agentTasks.remove(task.id), onClose);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </div>
              </div>
              {actionError && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-300">{actionError}</p>}
              {error && !actionError && (
                <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-300">This task no longer exists or could not be loaded ({error}).</p>
              )}
            </header>

            <div className="space-y-3 p-4 md:p-5">
              {task.question && (
                <Section title={task.question.by === 'system' ? 'Decision needed' : 'Question for you'} tone="attention">
                  <p className="whitespace-pre-wrap text-sm font-medium [overflow-wrap:anywhere]">{task.question.text}</p>
                  {task.question.options.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {task.question.options.map((option) => (
                        <Button
                          key={option}
                          size="sm"
                          variant="outline"
                          className="h-auto min-h-8 whitespace-normal border-amber-500/50 bg-background text-left"
                          disabled={busy !== null}
                          onClick={() => void act(`answer:${option}`, () => api.agentTasks.answer(task.id, { option, text: answerText.trim() || undefined }), () => setAnswerText(''))}
                        >
                          {spinner(`answer:${option}`)}{option}
                        </Button>
                      ))}
                    </div>
                  )}
                  <label className="mt-3 block text-xs text-muted-foreground" htmlFor={`task-answer-${task.id}`}>
                    {task.question.options.length ? 'Add a note to your choice, or answer in your own words' : 'Your answer'}
                  </label>
                  <textarea
                    id={`task-answer-${task.id}`}
                    className={cn(FIELD_CLASS, 'mt-1 min-h-16 bg-background')}
                    value={answerText}
                    onChange={(event) => setAnswerText(event.target.value)}
                  />
                  <div className="mt-2 flex justify-end">
                    <Button size="sm" disabled={busy !== null || !answerText.trim()} onClick={() => void act('answer-text', () => api.agentTasks.answer(task.id, { text: answerText.trim() }), () => setAnswerText(''))}>
                      {spinner('answer-text')}Send answer
                    </Button>
                  </div>
                </Section>
              )}

              {!task.mandateConfirmed && !closed && (
                <Section title="Confirm the mandate" tone="attention">
                  <p className="text-xs text-muted-foreground">An agent created this task. Until you confirm what it may do on its own, every message it writes waits here as a draft.</p>
                  <p className="mt-2 whitespace-pre-wrap rounded-md bg-background/70 p-2 text-sm [overflow-wrap:anywhere]">{task.mandate || '(no mandate — it may not contact anyone)'}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy !== null} onClick={() => void act('confirm', () => api.agentTasks.confirmMandate(task.id))}>
                      {spinner('confirm') || <Check className="mr-1 h-3.5 w-3.5" aria-hidden />}Confirm mandate
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => onEdit(task)}>Change it</Button>
                  </div>
                </Section>
              )}

              {drafts.length > 0 && (
                <Section title={drafts.length === 1 ? 'Message to approve' : `${drafts.length} messages to approve`} tone="attention">
                  <ul className="space-y-2">
                    {drafts.map((message) => <MessageDraft key={message.id} message={message} onDone={() => void reload()} />)}
                  </ul>
                </Section>
              )}

              <Section title="Where it stands">
                {task.summary ? (
                  <div className="prose prose-sm max-w-none break-words dark:prose-invert prose-table:my-2 prose-th:whitespace-nowrap prose-th:px-2 prose-td:whitespace-nowrap prose-td:px-2">
                    <div className="overflow-x-auto [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.summary}</ReactMarkdown>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{task.running ? 'The agent is on its first step…' : 'The agent has not written a summary yet.'}</p>
                )}
              </Section>

              {task.checklist.length > 0 && (
                <Section title={`Plan · ${task.checklist.filter((item) => item.done).length}/${task.checklist.length}`}>
                  <ul className="space-y-1">
                    {task.checklist.map((item, index) => (
                      <li key={`${index}-${item.text}`} className="flex items-start gap-2 text-sm">
                        <span className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border', item.done ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-border')}>
                          {item.done && <Check className="h-3 w-3" aria-hidden />}
                        </span>
                        <span className={cn('[overflow-wrap:anywhere]', item.done && 'text-muted-foreground line-through')}>{item.text}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              <Section title="Brief and mandate">
                <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{task.brief}</p>
                <p className="mt-3 text-xs font-medium text-muted-foreground">
                  The agent may on its own {task.mandateConfirmed ? '' : '(not confirmed yet)'}
                </p>
                <p className="mt-0.5 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{task.mandate || '—'}</p>
              </Section>

              <Section title={`Diary${detail && detail.eventCount > events.length ? ` · newest ${events.length} of ${detail.eventCount}` : ''}`}>
                {!closed ? (
                  <div className="mb-2">
                    <label className="sr-only" htmlFor={`task-comment-${task.id}`}>Message the agent</label>
                    <textarea
                      id={`task-comment-${task.id}`}
                      className={cn(FIELD_CLASS, 'min-h-16')}
                      placeholder="Message the agent — e.g. “prefer printers in Brno” (wakes it up)"
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                    />
                    <div className="mt-1.5 flex justify-end">
                      <Button size="sm" disabled={busy !== null || !comment.trim()} onClick={() => void act('comment', () => api.agentTasks.comment(task.id, comment.trim()), () => setComment(''))}>
                        {spinner('comment') || <Send className="mr-1 h-3.5 w-3.5" aria-hidden />}Send to agent
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground"><AlertCircle className="h-3.5 w-3.5" aria-hidden /> Closed — move it back to Working to wake the agent.</p>
                )}
                {sent.length > 0 && (
                  <p className="mb-1 text-xs text-muted-foreground">{sent.length} message{sent.length === 1 ? '' : 's'} sent so far.</p>
                )}
                <ol className="divide-y divide-border/50">
                  {events.map((event) => <DiaryEntry key={event.id} event={event} onOpenChat={openChat} />)}
                </ol>
              </Section>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

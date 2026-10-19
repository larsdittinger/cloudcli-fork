import { useState } from 'react';
import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle, Bot, Check, CircleUser, Cog, ExternalLink, Inbox, Loader2, Mail, Pencil, Send, Trash2, X, Zap,
} from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { cn, formatDateTime } from '@/shared/utils';
import type { AgentTask, AgentTaskEvent, AgentTaskMessage, AgentTaskStatus } from '@/shared/types';
import { useAgentTaskDetail } from '@/modules/agent-tasks/hooks/useAgentTaskDetail';
import { AGENT_TASK_STATUSES, projectName } from '@/modules/agent-tasks/utils/agentTaskLabels';

type Props = {
  taskId: number | null;
  onClose: () => void;
  onEdit: (task: AgentTask) => void;
  /** Lifts the dialog above another one it opens from (the all-tasks overlay). */
  wrapperClassName?: string;
  /** Called when a chat link leaves for the chat, so a surrounding overlay can close too. */
  onOpenChat?: () => void;
};

const FIELD_CLASS =
  'w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

/** Wake reasons the server writes into a wake entry; each reads as `detail.wakeReasons.<reason>`. */
const WAKE_REASONS = ['created', 'message', 'owner_comment', 'owner_answer', 'owner_wake', 'owner_edit', 'mandate_confirmed', 'reopened', 'check', 'restart'];

/** Icon and color per diary author; the name is `detail.author.<author>`. */
const AUTHOR_STYLE: Record<AgentTaskEvent['author'], { icon: typeof Bot; className: string }> = {
  owner: { icon: CircleUser, className: 'text-sky-600 dark:text-sky-300' },
  agent: { icon: Bot, className: 'text-violet-600 dark:text-violet-300' },
  system: { icon: Cog, className: 'text-muted-foreground' },
  external: { icon: Inbox, className: 'text-emerald-600 dark:text-emerald-300' },
};

const LONG_EVENT = 600;

function CloseButton({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('agentTasks');
  return (
    <button type="button" aria-label={t('detail.close')} onClick={onClose} className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
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

/** The server writes "Woke up: created, message." in English; the reasons are shown in the UI language. */
function wakeText(event: AgentTaskEvent, t: TFunction): string {
  const reasons = event.text.replace(/^Woke up: /, '').replace(/\.$/, '').split(', ');
  return t('detail.wokeUp', { reasons: reasons.map((reason) => (WAKE_REASONS.includes(reason) ? t(`detail.wakeReasons.${reason}`) : reason)).join(', ') });
}

/** One diary entry; long ones fold so a supplier's e-mail does not push everything else away. */
function DiaryEntry({ event, onOpenChat }: { event: AgentTaskEvent; onOpenChat: (sessionId: string) => void }) {
  const { t } = useTranslation('agentTasks');
  // Whether a long entry is unfolded.
  const [expanded, setExpanded] = useState(false);
  const author = event.author in AUTHOR_STYLE ? event.author : 'system';
  const style = AUTHOR_STYLE[author];
  const Icon = event.kind === 'message_in' || event.kind === 'message_out' ? Mail : event.kind === 'wake' ? Zap : style.icon;
  const text = event.kind === 'wake' ? wakeText(event, t) : event.text;
  const long = text.length > LONG_EVENT;

  return (
    <li className="flex gap-2.5 py-2">
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', style.className)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className={cn('font-medium', style.className)}>{t(`detail.author.${author}`)}</span>
          <span className="tabular-nums text-muted-foreground">{formatDateTime(event.at)}</span>
          {event.sessionId && (
            <button type="button" className="inline-flex items-center gap-0.5 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => onOpenChat(event.sessionId as string)}>
              {t('detail.openChat')} <ExternalLink className="h-3 w-3" aria-hidden />
            </button>
          )}
        </div>
        <p className={cn('mt-0.5 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]', event.kind === 'wake' && 'text-muted-foreground', !expanded && long && 'line-clamp-6')}>
          {text}
        </p>
        {long && (
          <button type="button" className="mt-0.5 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setExpanded((value) => !value)}>
            {t(expanded ? 'detail.showLess' : 'detail.showAll')}
          </button>
        )}
      </div>
    </li>
  );
}

function MessageDraft({ message, onDone }: { message: AgentTaskMessage; onDone: () => void }) {
  const { t } = useTranslation('agentTasks');
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
        {t('detail.draftTo')} <span className="font-medium text-foreground">{message.to}</span>
        {message.subject && <> · {message.subject}</>}
        {message.status === 'failed' && <span className="text-red-600 dark:text-red-300"> · {message.statusDetail ? t('detail.draftFailedWithDetail', { detail: message.statusDetail }) : t('detail.draftFailed')}</span>}
      </p>
      <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{message.text}</p>
      {error && <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-300">{error}</p>}
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={() => void act('send')} disabled={busy !== null}>
          {busy === 'send' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Send className="mr-1 h-3.5 w-3.5" aria-hidden />}
          {t(message.status === 'failed' ? 'detail.sendAgain' : 'detail.send')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => void act('discard')} disabled={busy !== null}>{t('detail.discard')}</Button>
      </div>
    </li>
  );
}

/**
 * Used by AgentTasksPanel and AllTasksOverlay: everything about one task — the question waiting
 * for you, the mandate, drafts to approve, the agent's summary, the plan and
 * the diary — and the ways to steer it.
 */
export default function TaskDetail({ taskId, onClose, onEdit, wrapperClassName, onOpenChat }: Props) {
  const { t } = useTranslation('agentTasks');
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
    onOpenChat?.();
    navigate(`/session/${sessionId}`);
  };

  const spinner = (kind: string) => busy === kind && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />;

  return (
    <Dialog open={taskId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent wrapperClassName={wrapperClassName} className="max-h-[94vh] w-[min(100vw-1rem,52rem)] max-w-none overflow-y-auto p-0">
        {!task ? (
          <div className="relative p-5">
            <CloseButton onClose={onClose} />
            <DialogTitle className="not-sr-only text-base font-semibold">{t('detail.taskTitle', { id: taskId })}</DialogTitle>
            {error ? <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-300">{error}</p> : (
              <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t('detail.loading')}</p>
            )}
          </div>
        ) : (
          <div>
            <header className="sticky top-0 z-10 rounded-t-xl border-b border-border/60 bg-popover/95 px-4 pb-3 pt-4 backdrop-blur md:px-5">
              <CloseButton onClose={onClose} />
              <div className="flex items-start gap-3 pr-8">
                <div className="min-w-0 flex-1">
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {t(task.createdBy === 'agent' ? 'detail.metaByAgent' : 'detail.meta', { id: task.id, project: projectName(task.projectPath), date: formatDateTime(task.createdAt) })}
                  </p>
                  <DialogTitle className="not-sr-only mt-0.5 text-lg font-semibold leading-snug [overflow-wrap:anywhere]">{task.title}</DialogTitle>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`task-status-${task.id}`}>{t('detail.status')}</label>
                <select
                  id={`task-status-${task.id}`}
                  className="rounded-md border border-input bg-transparent px-2 py-1 text-sm"
                  value={task.status}
                  disabled={busy !== null}
                  onChange={(event) => {
                    const next = event.target.value as AgentTaskStatus;
                    if ((next === 'done' || next === 'cancelled') && !window.confirm(
                      t(task.running ? 'detail.confirmCloseRunning' : 'detail.confirmClose', { id: task.id, status: t(`status.${next}`).toLowerCase() }),
                    )) return;
                    void act('status', () => api.agentTasks.setStatus(task.id, next));
                  }}
                >
                  {AGENT_TASK_STATUSES.map((status) => (
                    <option key={status} value={status}>{t(`status.${status}`)}</option>
                  ))}
                </select>
                {task.running ? (
                  <button type="button" onClick={() => openChat(task.running?.sessionId as string)} className="inline-flex items-center gap-1 rounded-full bg-violet-500/15 px-2 py-1 text-xs font-medium text-violet-700 hover:bg-violet-500/25 dark:text-violet-300">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> {t('detail.agentWorkingOpenChat')}
                  </button>
                ) : !closed && task.nextCheckAt ? (
                  <span className="text-xs tabular-nums text-muted-foreground">{t('detail.nextCheck', { date: formatDateTime(task.nextCheckAt) })}</span>
                ) : null}
                <div className="ml-auto flex flex-wrap gap-1.5">
                  {!closed && (
                    <Button size="sm" variant="outline" disabled={busy !== null || task.running !== null} onClick={() => void act('wake', () => api.agentTasks.wake(task.id))}>
                      {spinner('wake') || <Zap className="mr-1 h-3.5 w-3.5" aria-hidden />}{t('detail.wakeNow')}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => onEdit(task)} disabled={busy !== null}>
                    <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden />{t('detail.edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('detail.deleteTask')}
                    disabled={busy !== null}
                    onClick={() => {
                      if (!window.confirm(t('detail.confirmDelete', { id: task.id, title: task.title }))) return;
                      void act('delete', () => api.agentTasks.remove(task.id), onClose);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </div>
              </div>
              {actionError && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-300">{actionError}</p>}
              {error && !actionError && (
                <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-300">{t('detail.notFound', { error })}</p>
              )}
            </header>

            <div className="space-y-3 p-4 md:p-5">
              {task.question && (
                <Section title={t(task.question.by === 'system' ? 'detail.decisionNeeded' : 'detail.questionForYou')} tone="attention">
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
                    {t(task.question.options.length ? 'detail.answerNoteLabel' : 'detail.yourAnswer')}
                  </label>
                  <textarea
                    id={`task-answer-${task.id}`}
                    className={cn(FIELD_CLASS, 'mt-1 min-h-16 bg-background')}
                    value={answerText}
                    onChange={(event) => setAnswerText(event.target.value)}
                  />
                  <div className="mt-2 flex justify-end">
                    <Button size="sm" disabled={busy !== null || !answerText.trim()} onClick={() => void act('answer-text', () => api.agentTasks.answer(task.id, { text: answerText.trim() }), () => setAnswerText(''))}>
                      {spinner('answer-text')}{t('detail.sendAnswer')}
                    </Button>
                  </div>
                </Section>
              )}

              {!task.mandateConfirmed && !closed && (
                <Section title={t('detail.confirmMandateTitle')} tone="attention">
                  <p className="text-xs text-muted-foreground">{t('detail.confirmMandateExplain')}</p>
                  <p className="mt-2 whitespace-pre-wrap rounded-md bg-background/70 p-2 text-sm [overflow-wrap:anywhere]">{task.mandate || t('detail.noMandate')}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy !== null} onClick={() => void act('confirm', () => api.agentTasks.confirmMandate(task.id))}>
                      {spinner('confirm') || <Check className="mr-1 h-3.5 w-3.5" aria-hidden />}{t('detail.confirmMandate')}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => onEdit(task)}>{t('detail.changeIt')}</Button>
                  </div>
                </Section>
              )}

              {drafts.length > 0 && (
                <Section title={t('detail.drafts', { count: drafts.length })} tone="attention">
                  <ul className="space-y-2">
                    {drafts.map((message) => <MessageDraft key={message.id} message={message} onDone={() => void reload()} />)}
                  </ul>
                </Section>
              )}

              <Section title={t('detail.whereItStands')}>
                {task.summary ? (
                  <div className="prose prose-sm max-w-none break-words dark:prose-invert prose-table:my-2 prose-th:whitespace-nowrap prose-th:px-2 prose-td:whitespace-nowrap prose-td:px-2">
                    <div className="overflow-x-auto [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.summary}</ReactMarkdown>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{t(task.running ? 'detail.firstStep' : 'detail.noSummary')}</p>
                )}
              </Section>

              {task.checklist.length > 0 && (
                <Section title={t('detail.plan', { done: task.checklist.filter((item) => item.done).length, total: task.checklist.length })}>
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

              <Section title={t('detail.briefAndMandate')}>
                <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{task.brief}</p>
                <p className="mt-3 text-xs font-medium text-muted-foreground">
                  {t(task.mandateConfirmed ? 'detail.mayOnItsOwn' : 'detail.mayOnItsOwnUnconfirmed')}
                </p>
                <p className="mt-0.5 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{task.mandate || '—'}</p>
              </Section>

              <Section title={detail && detail.eventCount > events.length ? t('detail.diaryNewest', { shown: events.length, total: detail.eventCount }) : t('detail.diary')}>
                {!closed ? (
                  <div className="mb-2">
                    <label className="sr-only" htmlFor={`task-comment-${task.id}`}>{t('detail.messageAgent')}</label>
                    <textarea
                      id={`task-comment-${task.id}`}
                      className={cn(FIELD_CLASS, 'min-h-16')}
                      placeholder={t('detail.commentPlaceholder')}
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                    />
                    <div className="mt-1.5 flex justify-end">
                      <Button size="sm" disabled={busy !== null || !comment.trim()} onClick={() => void act('comment', () => api.agentTasks.comment(task.id, comment.trim()), () => setComment(''))}>
                        {spinner('comment') || <Send className="mr-1 h-3.5 w-3.5" aria-hidden />}{t('detail.sendToAgent')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground"><AlertCircle className="h-3.5 w-3.5" aria-hidden /> {t('detail.closedHint')}</p>
                )}
                {sent.length > 0 && (
                  <p className="mb-1 text-xs text-muted-foreground">{t('detail.sentSoFar', { count: sent.length })}</p>
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

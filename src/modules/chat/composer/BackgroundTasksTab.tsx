import { useEffect, useMemo, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Bot, ChevronRight, ChevronUp, Eye, Terminal, Workflow, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { BackgroundTask, SubagentActivity } from '@/shared/types';
import { api, readApiJson } from '@/shared/api';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { cn } from '@/shared/utils';
import { SubagentTimeline } from '@/modules/chat/tools/SubagentTimeline';
import { useTranscriptSessionId } from '@/modules/chat/context/TranscriptSessionContext';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import { CLAIMS_ESCAPE_ATTRIBUTE } from '@/modules/chat/utils/escapeOwnership';

type BackgroundTasksTabProps = {
  tasks: BackgroundTask[];
  isInputFocused?: boolean;
};

const AGENT_TASK_TYPES = new Set(['local_agent', 'remote_agent', 'in_process_teammate']);

/**
 * Only a local agent writes a transcript the server can read
 * (`subagents/agent-<taskId>.jsonl`); a remote one or a teammate does not.
 */
const READABLE_AGENT_TASK_TYPE = 'local_agent';

/** How often an open agent's transcript is re-read while it runs. */
const AGENT_TRANSCRIPT_POLL_MS = 3_000;

/**
 * How long an agent may report no progress before its row says so. Progress
 * comes per tool call, so a long build or a long think stays quiet too — it
 * is a hint to look, not a verdict.
 */
const QUIET_AGENT_WARNING_MS = 5 * 60_000;

/**
 * The newest steps an open transcript draws; older ones are counted, not
 * drawn. Kept within SubagentTimeline's first page so the newest step is
 * never behind its "show more".
 */
const AGENT_TRANSCRIPT_TAIL = 25;

/** What the agent-transcript route answers with. */
type SubagentActivityPayload = {
  agent: { id: string; label?: string; model?: string };
  activity: SubagentActivity[];
  activityCount: number;
};

/** Tokens the way the CLI writes them: 725k rather than 724,871. */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : `${tokens}`;
}

function iconForTask(taskType: string): LucideIcon {
  if (taskType === 'local_bash') return Terminal;
  if (taskType.startsWith('monitor')) return Eye;
  if (taskType === 'local_workflow') return Workflow;
  return Bot;
}

/**
 * Status tab for work that outlives the turn — subagents started with
 * `run_in_background`, background shells, monitors. The turn's activity
 * indicator is gone by then, so without this the session looks idle while
 * agents keep working, sometimes for hours.
 *
 * Rendered by ChatComposer in the activity indicator's slot: beside the
 * "Thinking…" tab while a turn runs, on its own once the turn is over. Opens
 * a list of what each task is doing and for how long.
 */
export default function BackgroundTasksTab({ tasks, isInputFocused = false }: BackgroundTasksTabProps) {
  const { t } = useTranslation('chat');
  // Whether the per-task list is unfolded; the tab alone only gives a count.
  const [isOpen, setIsOpen] = useState(false);
  // Wall clock for the elapsed labels, ticking only while a task has a start time.
  const [now, setNow] = useState(() => Date.now());
  // The agent whose transcript is open in the dialog, by task id so the
  // dialog keeps following it as the list is re-sent with fresh numbers.
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionId = useTranscriptSessionId();
  const hasTimedTask = tasks.some((task) => task.startedAt);
  const openAgent = openAgentId ? tasks.find((task) => task.taskId === openAgentId) ?? null : null;

  useEffect(() => {
    if (!hasTimedTask) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasTimedTask]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  if (tasks.length === 0 && !openAgentId) return null;

  const formatElapsed = (startedAt: number | null): string => {
    if (!startedAt) return '';
    const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return t('backgroundTasks.elapsed.hoursMinutes', { hours, minutes, defaultValue: '{{hours}}h {{minutes}}m' });
    }
    if (minutes > 0) {
      return t('claudeStatus.elapsed.minutesSeconds', { minutes, seconds, defaultValue: '{{minutes}}m {{seconds}}s' });
    }
    return t('claudeStatus.elapsed.seconds', { count: seconds, defaultValue: '{{count}}s' });
  };

  const count = tasks.length;
  const onlyAgents = tasks.every((task) => AGENT_TASK_TYPES.has(task.taskType));
  const label = onlyAgents
    ? t('backgroundTasks.agents', { count, defaultValue: count === 1 ? '{{count}} agent' : '{{count}} agents' })
    : t('backgroundTasks.tasks', { count, defaultValue: count === 1 ? '{{count}} task' : '{{count}} tasks' });
  const startTimes = tasks.map((task) => task.startedAt).filter((value): value is number => Boolean(value));
  const longestElapsed = startTimes.length > 0 ? formatElapsed(Math.min(...startTimes)) : '';
  // Spent tokens are the quickest sign the agents are not stuck: the number keeps climbing.
  const reportedTokens = tasks.map((task) => task.totalTokens).filter((value): value is number => typeof value === 'number');
  const totalTokens = reportedTokens.length > 0 ? reportedTokens.reduce((sum, value) => sum + value, 0) : null;

  const tabSurfaceClassName = cn(
    'inline-flex h-8 items-center rounded-b-none rounded-t-lg border border-b-0 bg-card px-3 text-xs transition-all duration-200',
    isInputFocused
      ? 'border-purple-400/40 shadow-[0_-1px_2px_hsl(var(--foreground)/0.08),1px_0_2px_hsl(var(--foreground)/0.06),-1px_0_2px_hsl(var(--foreground)/0.06)]'
      : 'border-purple-300/50 shadow-[0_-1px_1px_hsl(var(--foreground)/0.04),1px_0_1px_hsl(var(--foreground)/0.03),-1px_0_1px_hsl(var(--foreground)/0.03)] dark:border-purple-500/30',
  );

  return (
    <div ref={containerRef} className="pointer-events-auto relative">
      {isOpen && (
        <div
          role="list"
          // Escape folds the list; without the mark it would also stop the chat and its agents.
          {...{ [CLAIMS_ESCAPE_ATTRIBUTE]: '' }}
          className="absolute bottom-full left-0 z-20 mb-1.5 max-h-72 w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-border/60 bg-card p-1 shadow-lg"
        >
          {tasks.map((task) => {
            const Icon = iconForTask(task.taskType);
            const details = [
              task.activity,
              task.toolUses
                ? t('backgroundTasks.toolUses', {
                  count: task.toolUses,
                  defaultValue: task.toolUses === 1 ? '{{count}} tool' : '{{count}} tools',
                })
                : null,
              typeof task.totalTokens === 'number'
                ? t('backgroundTasks.tokens', { tokens: formatTokenCount(task.totalTokens), defaultValue: '{{tokens}} tokens' })
                : null,
              task.subagentType,
            ].filter(Boolean).join(' · ');
            const quietFor = task.lastActivityAt ? now - task.lastActivityAt : 0;
            const canOpen = Boolean(sessionId) && task.taskType === READABLE_AGENT_TASK_TYPE;
            const content = (
              <>
                <Icon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-purple-500 dark:text-purple-400" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">
                    {task.description || task.taskType}
                  </div>
                  {details && <div className="truncate text-[11px] text-muted-foreground">{details}</div>}
                  {task.lastActivityAt && (
                    <div className={cn(
                      'text-[11px] tabular-nums',
                      quietFor >= QUIET_AGENT_WARNING_MS ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground/70',
                    )}
                    >
                      {quietFor >= QUIET_AGENT_WARNING_MS
                        ? t('backgroundTasks.quietFor', { elapsed: formatElapsed(task.lastActivityAt), defaultValue: 'No progress for {{elapsed}}' })
                        : t('backgroundTasks.lastActivity', { elapsed: formatElapsed(task.lastActivityAt), defaultValue: 'Last step {{elapsed}} ago' })}
                    </div>
                  )}
                </div>
                <span className="flex-shrink-0 pt-px text-[11px] tabular-nums text-muted-foreground/70">
                  {formatElapsed(task.startedAt)}
                </span>
                {canOpen && <ChevronRight className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60" aria-hidden />}
              </>
            );

            return canOpen ? (
              <button
                key={task.taskId}
                type="button"
                role="listitem"
                onClick={() => {
                  setOpenAgentId(task.taskId);
                  setIsOpen(false);
                }}
                title={t('backgroundTasks.openTranscript', { defaultValue: 'Show what the agent is doing' })}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
              >
                {content}
              </button>
            ) : (
              <div key={task.taskId} role="listitem" className="flex items-start gap-2 rounded-md px-2 py-1.5">
                {content}
              </div>
            );
          })}
        </div>
      )}

      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((previous) => !previous)}
        title={t('backgroundTasks.title', { defaultValue: 'Still running in the background after the reply' })}
        className={cn(tabSurfaceClassName, 'gap-2 text-purple-700 hover:text-purple-900 dark:text-purple-300 dark:hover:text-purple-200')}
      >
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400" aria-hidden />
        <span className="font-medium">
          {label}
          <span className="hidden sm:inline">{` ${t('backgroundTasks.suffix', { defaultValue: 'in background' })}`}</span>
        </span>
        {longestElapsed && <span className="tabular-nums text-muted-foreground/60">{longestElapsed}</span>}
        {totalTokens !== null && (
          <span className="tabular-nums text-muted-foreground/60">
            {t('backgroundTasks.tokens', { tokens: formatTokenCount(totalTokens), defaultValue: '{{tokens}} tokens' })}
          </span>
        )}
        <ChevronUp className={cn('h-3 w-3 transition-transform duration-150', !isOpen && 'rotate-180')} aria-hidden />
      </button>

      {openAgentId && sessionId && (
        <AgentTranscriptDialog
          sessionId={sessionId}
          agentId={openAgentId}
          task={openAgent}
          tokensLabel={typeof openAgent?.totalTokens === 'number'
            ? t('backgroundTasks.tokens', { tokens: formatTokenCount(openAgent.totalTokens), defaultValue: '{{tokens}} tokens' })
            : null}
          elapsedLabel={openAgent ? formatElapsed(openAgent.startedAt) : ''}
          onClose={() => setOpenAgentId(null)}
        />
      )}
    </div>
  );
}

type AgentTranscriptDialogProps = {
  sessionId: string;
  agentId: string;
  /** The agent's live entry; null once it has finished and left the list. */
  task: BackgroundTask | null;
  tokensLabel: string | null;
  elapsedLabel: string;
  onClose: () => void;
};

/**
 * What one background agent has done so far, read from its own transcript —
 * the CLI streams none of a background agent's work to the chat. Re-read
 * every few seconds while the agent is still in the session's task list, so
 * the newest step is always at the bottom.
 */
function AgentTranscriptDialog({ sessionId, agentId, task, tokensLabel, elapsedLabel, onClose }: AgentTranscriptDialogProps) {
  const { t } = useTranslation('chat');
  // The last transcript read, or why there is none; null until the first read lands.
  const [loaded, setLoaded] = useState<{ payload: SubagentActivityPayload } | { error: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the reader sits at the bottom, so a new step scrolls into view
  // without yanking someone who scrolled up to read an older one.
  const stickToBottomRef = useRef(true);
  const createDiff = useMemo(() => createCachedDiffCalculator(), []);
  const isRunning = task !== null;

  useEffect(() => {
    let cancelled = false;
    let nextRead: ReturnType<typeof setTimeout> | undefined;

    const read = async () => {
      try {
        const payload = await readApiJson<{ data: SubagentActivityPayload }>(await api.subagentActivity(sessionId, agentId));
        if (!cancelled) {
          setLoaded({ payload: payload.data });
        }
      } catch (error) {
        if (!cancelled) {
          // A later failed read keeps the last transcript: what the agent did stays true.
          setLoaded((previous) => previous && 'payload' in previous
            ? previous
            : { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (!cancelled && isRunning) {
        nextRead = setTimeout(read, AGENT_TRANSCRIPT_POLL_MS);
      }
    };
    void read();

    return () => {
      cancelled = true;
      clearTimeout(nextRead);
    };
  }, [sessionId, agentId, isRunning]);

  useEffect(() => {
    const container = scrollRef.current;
    if (container && stickToBottomRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [loaded]);

  const payload = loaded && 'payload' in loaded ? loaded.payload : null;
  const title = task?.description || payload?.agent.label || agentId;
  const meta = [
    isRunning ? task?.activity : t('backgroundTasks.agentFinished', { defaultValue: 'Finished' }),
    task?.toolUses ? t('backgroundTasks.toolUses', { count: task.toolUses, defaultValue: task.toolUses === 1 ? '{{count}} tool' : '{{count}} tools' }) : null,
    tokensLabel,
    elapsedLabel,
    payload?.agent.model,
  ].filter(Boolean).join(' · ');
  const tail = payload ? payload.activity.slice(-AGENT_TRANSCRIPT_TAIL) : [];

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[88vh] w-[min(100vw-1rem,52rem)] max-w-none flex-col gap-2 p-4">
        <div className="flex items-center gap-2">
          {/* DialogTitle is screen-reader-only by default; here it is the visible header. */}
          <DialogTitle className="not-sr-only flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
            {isRunning && <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400" aria-hidden />}
            <span className="min-w-0 truncate">{title}</span>
          </DialogTitle>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('backgroundTasks.closeTranscript', { defaultValue: 'Close' })}
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {meta && <div className="truncate text-[11px] text-muted-foreground">{meta}</div>}
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
          }}
          className="min-h-32 flex-1 overflow-y-auto rounded-md border border-border/60 p-2"
        >
          {!loaded && <div className="text-xs text-muted-foreground">{t('backgroundTasks.transcriptLoading', { defaultValue: 'Reading the agent\'s steps…' })}</div>}
          {loaded && 'error' in loaded && (
            <div className="text-xs text-muted-foreground">
              {t('backgroundTasks.transcriptUnavailable', { reason: loaded.error, defaultValue: 'Steps unavailable: {{reason}}' })}
            </div>
          )}
          {payload && tail.length === 0 && (
            <div className="text-xs text-muted-foreground">{t('backgroundTasks.transcriptEmpty', { defaultValue: 'Nothing recorded yet' })}</div>
          )}
          {payload && tail.length > 0 && (
            <SubagentTimeline
              // Keyed by the first drawn step, so a slid window re-renders
              // from its start instead of keeping a stale "show more" limit.
              key={tail[0]?.toolId ?? tail[0]?.timestamp ?? 'start'}
              activity={tail}
              activityCount={payload.activityCount}
              createDiff={createDiff}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

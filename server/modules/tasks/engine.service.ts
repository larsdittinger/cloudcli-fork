import { randomUUID } from 'node:crypto';

import { sessionsDb, taskEventsDb, tasksDb } from '@/modules/database/index.js';
import type { TaskRow } from '@/modules/database/index.js';
import { renderWakePrompt } from '@/modules/tasks/task-prompt.js';
import { broadcastTasksUpdated } from '@/modules/tasks/tasks-broadcast.js';
import { tasksService } from '@/modules/tasks/tasks.service.js';
import { setEngineHooks } from '@/modules/tasks/wake-queue.js';
import { broadcastSessionUpserted, chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

const DEFAULT_TICK_MS = 15_000;
const HOUR_MS = 60 * 60_000;
/** An agent that leaves a working task without a plan is checked on after this long. */
const IDLE_CHECK_MS = 4 * HOUR_MS;
/** Waiting for someone outside without a date: follow up after this long. */
const FOLLOW_UP_MS = 48 * HOUR_MS;
const RETRY_MS = 30 * 60_000;
/** A provider usage limit without a stated reset time is tried again after this long, doubling while it lasts. */
const LIMIT_RETRY_MS = HOUR_MS;
const MAX_LIMIT_RETRY_MS = 6 * HOUR_MS;
/** A stated reset further out than this is not believed (weekly limits are the longest). */
const MAX_LIMIT_WAIT_MS = 8 * 24 * HOUR_MS;
/** How Claude Code and Codex word a used-up subscription or API limit. */
const LIMIT_PATTERN = /usage limit|rate[ _-]?limit|hit your (usage )?limit|limit reached|quota exceeded|too many requests/i;
const MAX_FAILURES = 3;
/** More wakes than this within a day (since the owner last spoke) means the task is going in circles. */
const MAX_WAKES_PER_DAY = 20;
/** A run longer than this is stuck (a hung tool, a sleep loop): it is stopped and booked as a failure. */
const DEFAULT_RUN_TIMEOUT_MS = 3 * HOUR_MS;
/** Nobody sits at a task's chat: tools that wait for a person would hang the run. */
const INTERACTIVE_TOOLS = ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'];
/** Reasons the owner gives; only these wake a task that waits for the owner. */
const OWNER_REASONS = new Set(['owner_answer', 'owner_comment', 'owner_wake', 'owner_edit', 'owner_status', 'mandate_confirmed', 'reopened']);

let runtime: ProviderRuntimeGateway | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let maxRuns = 2;
let currentTime: () => Date = () => new Date();
let kickPending = false;
let runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS;
/** Set during shutdown: runs cut short then are left for restart recovery, not booked as failures. */
let closing = false;
const inFlight = new Set<Promise<void>>();
/** Runs already booked (by the watchdog); their late end must not be booked twice. */
const finishedRuns = new Set<string>();
/** Per provider: no task of it starts before this time (its usage limit is used up). */
const providerCooldown = new Map<string, number>();
/** Per provider: limits hit in a row without a stated reset, for the doubling retry. */
const limitStreak = new Map<string, number>();

/** What a finished run tells the engine beyond its error. */
type RunOutcome = { limitUntil: Date | null; replayNews: boolean };

const chatTime = new Intl.DateTimeFormat('cs-CZ', {
  timeZone: 'Europe/Prague', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

/**
 * Runtimes report most failures (not logged in, quota, API errors) as an
 * `error` chat event rather than by throwing. Read right after the turn,
 * before the registry evicts the run. (Same rule as the schedules runner.)
 */
function reportedError(sessionId: string): string | null {
  const events = chatRunRegistry.getRun(sessionId)?.events ?? [];
  const error = [...events].reverse().find((event) => event.kind === 'error');
  if (!error) return null;
  const content = (error as { content?: unknown }).content;
  return typeof content === 'string' && content.trim() ? content.trim() : 'The agent reported an error.';
}

/**
 * Read right after a run, before the registry evicts it. A run that used no
 * tools never did anything, so a usage limit is read from its error or text
 * and its news is shown again next time. One that used tools did work — an
 * agent quoting "rate limit" from a supplier's API is not out of quota, and
 * replaying its news could repeat what it already did.
 */
function readRunOutcome(sessionId: string, provider: string, error: string | null, now: Date): RunOutcome {
  const events = chatRunRegistry.getRun(sessionId)?.events ?? [];
  if (events.some((event) => event.kind === 'tool_use')) return { limitUntil: null, replayNews: false };
  const texts = [error ?? '', ...events.filter((event) => event.kind === 'text').map((event) => String((event as { content?: unknown }).content ?? ''))];
  const hit = texts.find((text) => LIMIT_PATTERN.test(text));
  if (!hit) {
    limitStreak.delete(provider);
    return { limitUntil: null, replayNews: Boolean(error) };
  }
  // Claude Code states the reset as epoch seconds: "Claude AI usage limit reached|1760000000".
  const stated = /\|(\d{10})\b/.exec(hit);
  const resetMs = stated ? Number(stated[1]) * 1000 : NaN;
  if (Number.isFinite(resetMs) && resetMs > now.getTime() && resetMs - now.getTime() <= MAX_LIMIT_WAIT_MS) {
    return { limitUntil: new Date(resetMs), replayNews: true };
  }
  const streak = (limitStreak.get(provider) ?? 0) + 1;
  limitStreak.set(provider, streak);
  return { limitUntil: new Date(now.getTime() + Math.min(LIMIT_RETRY_MS * 2 ** (streak - 1), MAX_LIMIT_RETRY_MS)), replayNews: true };
}

/** The wake entry of a run carries the diary position and reasons it started with. */
function wakeOf(taskId: number, sessionId: string): { seenBefore: number | null; reasons: string[] } {
  const wake = taskEventsDb.list(taskId).find((event) => event.kind === 'wake' && event.session_id === sessionId);
  try {
    const meta = JSON.parse(wake?.meta ?? '{}') as { seenBefore?: unknown; reasons?: unknown };
    return {
      seenBefore: typeof meta.seenBefore === 'number' ? meta.seenBefore : null,
      reasons: Array.isArray(meta.reasons) ? meta.reasons.filter((reason): reason is string => typeof reason === 'string') : [],
    };
  } catch {
    return { seenBefore: null, reasons: [] };
  }
}

function runOptions(task: TaskRow): Record<string, unknown> {
  const options: Record<string, unknown> = {
    toolsSettings: { allowedTools: [], disallowedTools: INTERACTIVE_TOOLS, skipPermissions: false },
  };
  if (task.model) options.model = task.model;
  if (task.effort) options.effort = task.effort;
  if (task.permission_mode && task.permission_mode !== 'default') options.permissionMode = task.permission_mode;
  return options;
}

function isOpen(task: TaskRow): boolean {
  return task.status !== 'done' && task.status !== 'cancelled';
}

function systemNote(taskId: number, kind: string, text: string, sessionId: string | null = null): void {
  taskEventsDb.add({ taskId, author: 'system', kind, text, sessionId });
}

/** Wakes since the later of 24 h ago and the owner's last word — answering resets the loop guard. */
function recentWakes(task: TaskRow, now: Date): number {
  const dayAgo = new Date(now.getTime() - 24 * HOUR_MS).toISOString();
  const ownerSpoke = taskEventsDb.lastAt(task.id, 'owner');
  return taskEventsDb.countSince(task.id, 'wake', ownerSpoke && ownerSpoke > dayAgo ? ownerSpoke : dayAgo);
}

/**
 * Starts one run of `task`: a fresh chat whose first message is the card.
 * Returns false when nothing started (the loop guard parked the task, or the
 * start failed — then the wake reasons go back to the queue).
 */
function startTaskRun(task: TaskRow, now: Date): boolean {
  const reasons = tasksDb.takePendingWake(task.id);
  const checkDue = task.next_check_at !== null && task.next_check_at <= now.toISOString();
  if (checkDue && !reasons.includes('check')) reasons.push('check');
  if (reasons.length === 0) reasons.push('check');

  if (recentWakes(task, now) >= MAX_WAKES_PER_DAY) {
    tasksService.ask(task.id, {
      question: `The agent woke up ${MAX_WAKES_PER_DAY} times within a day without settling. Look at the diary — should it continue?`,
      options: ['Continue', 'Cancel task'],
    }, 'system');
    return false;
  }

  const sessionId = randomUUID();
  let prompt: string;
  try {
    sessionsDb.createAppSession(sessionId, task.provider, task.project_path, `📋 #${task.id} ${task.title} · ${chatTime.format(now)}`.slice(0, 120), task.owner_user_id);

    // What the agent has not seen yet, minus its own notes and earlier wake markers.
    const unseen = taskEventsDb.list(task.id, { afterId: task.seen_event_id });
    const newEvents = unseen.filter((event) => event.author !== 'agent' && event.kind !== 'wake');
    const olderCount = taskEventsDb.count(task.id) - unseen.length;

    taskEventsDb.add({
      taskId: task.id, author: 'system', kind: 'wake', text: `Woke up: ${reasons.join(', ')}.`, sessionId,
      meta: { seenBefore: task.seen_event_id, reasons },
    });
    tasksDb.update(task.id, {
      status: task.status === 'new' ? 'working' : task.status,
      // The due check is used up by this run; the agent plans the next one.
      next_check_at: checkDue ? null : task.next_check_at,
      seen_event_id: taskEventsDb.latestId(task.id),
    });
    prompt = renderWakePrompt(tasksDb.get(task.id) as TaskRow, reasons, newEvents, olderCount);
    tasksDb.setRunning(task.id, sessionId, now.toISOString());
  } catch (error) {
    // Nothing runs: never leave the task marked running, and keep why it should wake.
    try {
      tasksDb.setRunning(task.id, null, null);
      for (const reason of reasons) tasksDb.addPendingWake(task.id, reason);
    } catch {
      // The database itself is failing; the restart recovery will sort it out.
    }
    console.error('[Tasks] Could not start a run', { taskId: task.id, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
  broadcastTasksUpdated({ taskId: task.id });

  const execute = runtime as ProviderRuntimeGateway;
  const watchdog = setTimeout(() => {
    if (closing) return;
    void Promise.resolve(execute.abort(task.provider as never, sessionId)).catch(() => undefined);
    safeFinish(task.id, sessionId, `The run hit the ${Math.round(runTimeoutMs / 60_000)} min time limit and was stopped.`);
  }, runTimeoutMs);
  watchdog.unref?.();

  const run = (async () => {
    let error: string | null = null;
    let outcome: RunOutcome = { limitUntil: null, replayNews: false };
    try {
      await broadcastSessionUpserted(sessionId);
      const result = await runDetachedChatTurn(
        { sessionId, userId: task.owner_user_id, content: prompt, options: runOptions(task) },
        { runtime: execute },
      );
      error = result.started ? (result.error ?? reportedError(sessionId)) : (result.error ?? 'The chat turn did not start.');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      // Read before the registry evicts the run.
      outcome = readRunOutcome(sessionId, task.provider, error, currentTime());
      clearTimeout(watchdog);
    }
    // Shutdown cut the run short: leave it marked running for the next start's recovery.
    if (closing) return;
    safeFinish(task.id, sessionId, error, outcome);
  })();
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run));
  return true;
}

/** `finishTaskRun` once per run, never throwing into a promise nobody handles. */
function safeFinish(taskId: number, sessionId: string, error: string | null, outcome: RunOutcome = { limitUntil: null, replayNews: false }): void {
  if (finishedRuns.has(sessionId)) return;
  finishedRuns.add(sessionId);
  try {
    finishTaskRun(taskId, sessionId, error, outcome);
  } catch (caught) {
    console.error('[Tasks] Could not book the end of a run', { taskId, error: caught instanceof Error ? caught.message : String(caught) });
    try {
      tasksDb.setRunning(taskId, null, null);
    } catch {
      // Left for the restart recovery.
    }
  }
}

/** Books the end of a run and makes sure an open task never ends up without a next step. */
function finishTaskRun(taskId: number, sessionId: string, error: string | null, { limitUntil, replayNews }: RunOutcome): void {
  const task = tasksDb.get(taskId);
  // Deleted, or a newer run already owns the task (this one was stopped by the watchdog).
  if (!task || (task.running_session_id !== null && task.running_session_id !== sessionId)) return;
  tasksDb.setRunning(taskId, null, null);
  const now = currentTime();
  const wake = replayNews || limitUntil ? wakeOf(taskId, sessionId) : null;
  // A run that failed before doing anything did not read the news: the next one shows it again.
  if (wake?.seenBefore !== null && wake !== null && isOpen(task)) tasksDb.update(taskId, { seen_event_id: wake.seenBefore });

  if (limitUntil && isOpen(task)) {
    // The provider's limit, not the task's fault: nothing of that provider starts before the reset,
    // the failure count stays, and what woke the task (an owner's answer too) waits for then.
    providerCooldown.set(task.provider, Math.max(providerCooldown.get(task.provider) ?? 0, limitUntil.getTime()));
    for (const reason of wake?.reasons ?? []) if (reason !== 'check' && reason !== 'retry') tasksDb.addPendingWake(taskId, reason);
    if (task.status !== 'waiting_owner') tasksDb.update(taskId, { next_check_at: limitUntil.toISOString() });
    systemNote(taskId, 'run_end', `The ${task.provider} usage limit is reached; the agent tries again at ${chatTime.format(limitUntil)}. Not counted as a failure.`, sessionId);
  } else if (error && isOpen(task)) {
    const failures = task.failure_count + 1;
    tasksDb.update(taskId, { failure_count: failures });
    systemNote(taskId, 'run_end', `The run failed: ${error}`, sessionId);
    if (failures >= MAX_FAILURES) {
      tasksService.ask(taskId, {
        question: `The agent failed ${failures} times in a row (last error: ${error.slice(0, 300)}). Try again?`,
        options: ['Try again', 'Cancel task'],
      }, 'system');
    } else if (task.status !== 'waiting_owner') {
      tasksDb.update(taskId, { next_check_at: new Date(now.getTime() + RETRY_MS).toISOString() });
    }
  } else if (!error) {
    if (task.failure_count) tasksDb.update(taskId, { failure_count: 0 });
    const pending = tasksDb.get(taskId)?.pending_wake !== '[]';
    if (isOpen(task) && !task.next_check_at && !task.question && !pending) {
      if (task.status === 'waiting_external') {
        tasksDb.update(taskId, { next_check_at: new Date(now.getTime() + FOLLOW_UP_MS).toISOString() });
        systemNote(taskId, 'note', 'Waiting for a reply without a follow-up date; checking again in 2 days.', sessionId);
      } else if (task.status !== 'waiting_owner') {
        tasksDb.update(taskId, { next_check_at: new Date(now.getTime() + IDLE_CHECK_MS).toISOString() });
        systemNote(taskId, 'note', 'The agent planned no next step; checking again in 4 h.', sessionId);
      }
    }
  }
  broadcastTasksUpdated({ taskId });
  // Anything that arrived during the run (or waited for a free slot) starts now.
  tickTasks();
}

/**
 * Starts every task that should run now, up to the global limit. Synchronous
 * on purpose: runs are registered before it returns, so `settleTaskRuns`
 * also waits for the follow-up runs a finished run starts. Exported for tests.
 */
export function tickTasks(now: Date = currentTime()): Promise<void> {
  if (!runtime) return Promise.resolve();
  if (closing) return Promise.resolve();
  let free = maxRuns - tasksDb.countRunning();
  for (const task of tasksDb.listWakeable(now.toISOString())) {
    if (free <= 0) break;
    // The provider's usage limit is used up: its tasks wait for the reset.
    if ((providerCooldown.get(task.provider) ?? 0) > now.getTime()) continue;
    // A task waiting for the owner keeps other news (messages, restarts) until the owner acts.
    if (task.status === 'waiting_owner') {
      const reasons = JSON.parse(task.pending_wake || '[]') as string[];
      if (!reasons.some((reason) => OWNER_REASONS.has(reason))) continue;
    }
    try {
      if (startTaskRun(task, now)) free -= 1;
    } catch (error) {
      console.error('[Tasks] Could not start a run', { taskId: task.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return Promise.resolve();
}

function kick(): void {
  if (kickPending) return;
  kickPending = true;
  setImmediate(() => {
    kickPending = false;
    tickTasks();
  });
}

/** Used by tests (and shutdown) to wait until every started run, and the runs it led to, has ended. */
export async function settleTaskRuns(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

/**
 * Used by the tasks module at server start: resumes tasks a stopped process
 * interrupted, hooks wake requests to the engine and starts ticking.
 * `tickMs: 0` keeps the timer off (tests call `tickTasks` themselves).
 */
export function initializeTaskEngine(
  nextRuntime: ProviderRuntimeGateway,
  options: { tickMs?: number; now?: () => Date; maxRuns?: number; runTimeoutMs?: number } = {},
): void {
  closeTaskEngine();
  closing = false;
  finishedRuns.clear();
  providerCooldown.clear();
  limitStreak.clear();
  runtime = nextRuntime;
  const configuredTimeout = Number(process.env.CLOUDCLI_TASKS_RUN_TIMEOUT_MIN) * 60_000;
  runTimeoutMs = options.runTimeoutMs ?? (Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : DEFAULT_RUN_TIMEOUT_MS);
  currentTime = options.now ?? (() => new Date());
  const configured = Number(process.env.CLOUDCLI_TASKS_MAX_RUNS);
  maxRuns = options.maxRuns ?? (Number.isInteger(configured) && configured > 0 ? configured : 2);

  for (const task of tasksDb.resetRunningAfterRestart()) {
    systemNote(task.id, 'run_end', 'The run was interrupted by a server restart.', task.running_session_id);
    // The interrupted run may not have read its news; the restart prompt tells the agent to check what got done.
    const wake = task.running_session_id ? wakeOf(task.id, task.running_session_id) : null;
    if (wake?.seenBefore !== null && wake !== null && isOpen(task)) tasksDb.update(task.id, { seen_event_id: wake.seenBefore });
    if (isOpen(task)) tasksDb.addPendingWake(task.id, 'restart');
  }

  setEngineHooks({
    kick,
    abort: (taskId, sessionId) => {
      const provider = sessionsDb.getSessionById(sessionId)?.provider ?? 'claude';
      void Promise.resolve(runtime?.abort(provider as never, sessionId)).catch(() => undefined);
      console.log(`[Tasks] Stopped the run of task #${taskId}`);
    },
  });

  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  if (tickMs > 0) {
    tickTimer = setInterval(() => { tickTasks(); }, tickMs);
    tickTimer.unref?.();
    tickTasks();
  }
}

export function closeTaskEngine(): void {
  closing = true;
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  runtime = null;
  setEngineHooks(null);
}

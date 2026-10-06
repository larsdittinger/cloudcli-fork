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
const MAX_FAILURES = 3;
/** More wakes than this within a day (since the owner last spoke) means the task is going in circles. */
const MAX_WAKES_PER_DAY = 20;

let runtime: ProviderRuntimeGateway | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let maxRuns = 2;
let currentTime: () => Date = () => new Date();
let kickPending = false;
const inFlight = new Set<Promise<void>>();

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

function runOptions(task: TaskRow): Record<string, unknown> {
  const options: Record<string, unknown> = {};
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

/** Starts one run of `task`: a fresh chat whose first message is the card. */
function startTaskRun(task: TaskRow, now: Date): void {
  const reasons = tasksDb.takePendingWake(task.id);
  const checkDue = task.next_check_at !== null && task.next_check_at <= now.toISOString();
  if (checkDue && !reasons.includes('check')) reasons.push('check');
  if (reasons.length === 0) reasons.push('check');

  if (recentWakes(task, now) >= MAX_WAKES_PER_DAY) {
    tasksService.ask(task.id, {
      question: `The agent woke up ${MAX_WAKES_PER_DAY} times within a day without settling. Look at the diary — should it continue?`,
      options: ['Continue', 'Cancel task'],
    }, 'system');
    return;
  }

  const sessionId = randomUUID();
  sessionsDb.createAppSession(sessionId, task.provider, task.project_path, `📋 #${task.id} ${task.title} · ${chatTime.format(now)}`.slice(0, 120), task.owner_user_id);

  // What the agent has not seen yet, minus its own notes and earlier wake markers.
  const unseen = taskEventsDb.list(task.id, { afterId: task.seen_event_id });
  const newEvents = unseen.filter((event) => event.author !== 'agent' && event.kind !== 'wake');
  const olderCount = taskEventsDb.count(task.id) - unseen.length;

  const reasonText = reasons.join(', ');
  systemNote(task.id, 'wake', `Woke up: ${reasonText}.`, sessionId);
  tasksDb.update(task.id, {
    status: task.status === 'new' ? 'working' : task.status,
    // The due check is used up by this run; the agent plans the next one.
    next_check_at: checkDue ? null : task.next_check_at,
    seen_event_id: taskEventsDb.latestId(task.id),
  });
  tasksDb.setRunning(task.id, sessionId, now.toISOString());
  const prompt = renderWakePrompt(tasksDb.get(task.id) as TaskRow, reasons, newEvents, olderCount);
  broadcastTasksUpdated({ taskId: task.id });

  const execute = runtime as ProviderRuntimeGateway;
  const run = (async () => {
    let error: string | null = null;
    try {
      await broadcastSessionUpserted(sessionId);
      const result = await runDetachedChatTurn(
        { sessionId, userId: task.owner_user_id, content: prompt, options: runOptions(task) },
        { runtime: execute },
      );
      error = result.started ? (result.error ?? reportedError(sessionId)) : (result.error ?? 'The chat turn did not start.');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    finishTaskRun(task.id, sessionId, error);
  })();
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run));
}

/** Books the end of a run and makes sure an open task never ends up without a next step. */
function finishTaskRun(taskId: number, sessionId: string, error: string | null): void {
  const task = tasksDb.get(taskId);
  if (!task) return;
  tasksDb.setRunning(taskId, null, null);
  const now = currentTime();

  if (error && isOpen(task)) {
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
  let free = maxRuns - tasksDb.countRunning();
  for (const task of tasksDb.listWakeable(now.toISOString())) {
    if (free <= 0) break;
    try {
      startTaskRun(task, now);
      free -= 1;
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
export function initializeTaskEngine(nextRuntime: ProviderRuntimeGateway, options: { tickMs?: number; now?: () => Date; maxRuns?: number } = {}): void {
  closeTaskEngine();
  runtime = nextRuntime;
  currentTime = options.now ?? (() => new Date());
  const configured = Number(process.env.CLOUDCLI_TASKS_MAX_RUNS);
  maxRuns = options.maxRuns ?? (Number.isInteger(configured) && configured > 0 ? configured : 2);

  for (const task of tasksDb.resetRunningAfterRestart()) {
    systemNote(task.id, 'run_end', 'The run was interrupted by a server restart.', task.running_session_id);
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
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  runtime = null;
  setEngineHooks(null);
}

import fs from 'node:fs';

import { scheduleRunsDb, schedulesDb } from '@/modules/database/index.js';
import type { ScheduleRow, ScheduleRunRow } from '@/modules/database/index.js';
import { nextRunAfter, parseScheduleSpec } from '@/modules/schedules/schedule-spec.js';
import type { ScheduleSpec } from '@/modules/schedules/schedule-spec.js';
import { broadcastSchedulesUpdated } from '@/modules/schedules/schedules-broadcast.js';

/**
 * Runs one schedule run to its end and records the result on the run row
 * (`scheduleRunsDb.finish`). The scheduler only starts it and books the outcome.
 */
export type ScheduleExecutor = (schedule: ScheduleRow, run: ScheduleRunRow) => Promise<void>;

/** A due run this late means the server was down at the time: record it as missed instead of running it now. */
const MISSED_AFTER_MS = 5 * 60_000;
const DEFAULT_TICK_MS = 20_000;
const ONCE_RETRY_MS = 60_000;
const PRUNE_EVERY_MS = 24 * 60 * 60_000;
const RUN_RETENTION_DAYS = 90;
const RUNS_KEPT_PER_SCHEDULE = 500;

let executor: ScheduleExecutor | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let currentTime: () => Date = () => new Date();
const inFlight = new Set<Promise<void>>();

function readSpec(row: ScheduleRow): ScheduleSpec {
  return parseScheduleSpec(JSON.parse(row.schedule));
}

/** Used by the schedules service after a save: when this schedule should run next, from now. */
export function recomputeNextRun(row: ScheduleRow, from: Date = currentTime()): string | null {
  try {
    return nextRunAfter(readSpec(row), row.timezone, from)?.toISOString() ?? null;
  } catch {
    return null;
  }
}

function finishedRun(row: ScheduleRow, trigger: 'schedule' | 'manual', scheduledFor: string | null, status: 'missed' | 'skipped' | 'failed', error: string): ScheduleRunRow {
  const now = currentTime().toISOString();
  const run = (status === 'skipped' ? scheduleRunsDb.foldSkip(row.id, trigger, error, now) : null)
    ?? scheduleRunsDb.create({ scheduleId: row.id, trigger, scheduledFor, status, startedAt: null, finishedAt: now, error });
  schedulesDb.recordResult(row.id, status, now);
  broadcastSchedulesUpdated({ scheduleId: row.id, runId: run.id });
  return run;
}

/**
 * Used by the scheduler tick and by "Run now": starts one run of `row`, or
 * records a skipped run when the previous one is still going.
 */
export function startRun(row: ScheduleRow, trigger: 'schedule' | 'manual', scheduledFor: string | null): ScheduleRunRow {
  if (scheduleRunsDb.isRunning(row.id)) {
    return finishedRun(row, trigger, scheduledFor, 'skipped', 'The previous run was still running.');
  }
  if (!executor) {
    return finishedRun(row, trigger, scheduledFor, 'failed', 'The scheduler is not running.');
  }
  const run = scheduleRunsDb.create({ scheduleId: row.id, trigger, scheduledFor, status: 'running', startedAt: currentTime().toISOString() });
  broadcastSchedulesUpdated({ scheduleId: row.id, runId: run.id });

  const execute = executor;
  const task = (async () => {
    try {
      await execute(row, run);
    } catch (error) {
      scheduleRunsDb.finish(run.id, { status: 'failed', finishedAt: currentTime().toISOString(), error: error instanceof Error ? error.message : String(error) });
    }
    let final = scheduleRunsDb.get(run.id);
    if (final?.status === 'running') {
      scheduleRunsDb.finish(run.id, { status: 'failed', finishedAt: currentTime().toISOString(), error: 'The run ended without a result.' });
      final = scheduleRunsDb.get(run.id);
    }
    if (final) schedulesDb.recordResult(row.id, final.status, final.finished_at ?? currentTime().toISOString());
    broadcastSchedulesUpdated({ scheduleId: row.id, runId: run.id });
  })();
  inFlight.add(task);
  void task.finally(() => inFlight.delete(task));
  return run;
}

/** Starts or books every due schedule and moves each to its next time. Exported for tests. */
export async function tickSchedules(now: Date = currentTime()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const row of schedulesDb.listDue(now.toISOString())) {
      const dueAt = new Date(row.next_run_at as string);
      let spec: ScheduleSpec;
      try {
        spec = readSpec(row);
      } catch (error) {
        finishedRun(row, 'schedule', row.next_run_at, 'failed', `Invalid schedule: ${error instanceof Error ? error.message : String(error)}`);
        schedulesDb.setNextRun(row.id, null);
        continue;
      }

      const run = now.getTime() - dueAt.getTime() > MISSED_AFTER_MS
        ? finishedRun(row, 'schedule', row.next_run_at, 'missed', 'CloudCLI was not running at the scheduled time.')
        : startRun(row, 'schedule', row.next_run_at);

      if (spec.type === 'once' && run.status === 'skipped') {
        // A one-time job must not be used up by an overlap; try again shortly.
        schedulesDb.setNextRun(row.id, new Date(now.getTime() + ONCE_RETRY_MS).toISOString());
      } else if (spec.type === 'once') {
        schedulesDb.setNextRun(row.id, null, { disable: true });
      } else {
        // Intervals keep their rhythm from the planned time, not from whenever the tick ran.
        const next = nextRunAfter(spec, row.timezone, now, spec.type === 'interval' ? dueAt : null);
        schedulesDb.setNextRun(row.id, next?.toISOString() ?? null);
      }
    }
  } finally {
    ticking = false;
  }
}

/** Used by tests (and shutdown) to wait until every started run has booked its result. */
export async function settleRunningSchedules(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

function pruneOldRuns(): void {
  const cutoff = new Date(currentTime().getTime() - RUN_RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
  for (const logPath of scheduleRunsDb.prune(cutoff, RUNS_KEPT_PER_SCHEDULE)) {
    fs.rmSync(logPath, { force: true });
  }
}

/**
 * Used by the schedules module at server start: recovers runs the last process
 * left behind, plans schedules that have no next run yet and starts ticking.
 * `tickMs: 0` keeps the timer off (tests drive `tickSchedules` themselves).
 */
export function initializeScheduler(nextExecutor: ScheduleExecutor, options: { tickMs?: number; now?: () => Date } = {}): void {
  closeScheduler();
  executor = nextExecutor;
  currentTime = options.now ?? (() => new Date());

  const recovered = scheduleRunsDb.failRunningAfterRestart();
  if (recovered) console.log(`[Schedules] ${recovered} run(s) were in progress at shutdown and are marked failed`);

  for (const row of schedulesDb.list()) {
    if (row.enabled === 1 && !row.proposal && !row.next_run_at) {
      schedulesDb.setNextRun(row.id, recomputeNextRun(row));
    }
  }

  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  if (tickMs > 0) {
    pruneOldRuns();
    tickTimer = setInterval(() => { void tickSchedules(); }, tickMs);
    tickTimer.unref?.();
    pruneTimer = setInterval(pruneOldRuns, PRUNE_EVERY_MS);
    pruneTimer.unref?.();
    void tickSchedules();
  }
}

export function closeScheduler(): void {
  if (tickTimer) clearInterval(tickTimer);
  if (pruneTimer) clearInterval(pruneTimer);
  tickTimer = null;
  pruneTimer = null;
  executor = null;
}

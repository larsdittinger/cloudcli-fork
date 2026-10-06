import assert from 'node:assert/strict';
import test from 'node:test';

import { scheduleRunsDb, schedulesDb } from '@/modules/database/index.js';
import type { ScheduleRow, ScheduleRunRow } from '@/modules/database/index.js';
import {
  closeScheduler,
  initializeScheduler,
  settleRunningSchedules,
  startRun,
  tickSchedules,
} from '@/modules/schedules/scheduler.service.js';
import { scheduleInput, withIsolatedDatabase } from '@/modules/schedules/tests/helpers.js';

type Call = { schedule: ScheduleRow; run: ScheduleRunRow };

function recordingExecutor(calls: Call[], options: { hold?: Promise<void> } = {}) {
  return async (schedule: ScheduleRow, run: ScheduleRunRow) => {
    calls.push({ schedule, run });
    await options.hold;
    scheduleRunsDb.finish(run.id, { status: 'succeeded', finishedAt: new Date().toISOString(), output: 'done' });
  };
}

test('a due schedule runs once and its next run moves to the following day', async () => {
  await withIsolatedDatabase(async () => {
    const calls: Call[] = [];
    initializeScheduler(recordingExecutor(calls), { tickMs: 0 });
    const row = schedulesDb.create(scheduleInput({ next_run_at: '2026-10-06T06:00:00.000Z' }));

    await tickSchedules(new Date('2026-10-06T06:00:10Z'));
    await tickSchedules(new Date('2026-10-06T06:00:30Z'));
    await settleRunningSchedules();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].run.trigger, 'schedule');
    assert.equal(calls[0].run.scheduled_for, '2026-10-06T06:00:00.000Z');
    const after = schedulesDb.get(row.id)!;
    assert.equal(after.next_run_at, '2026-10-07T06:00:00.000Z');
    assert.equal(after.last_status, 'succeeded');
    assert.equal(scheduleRunsDb.list({ scheduleId: row.id })[0].status, 'succeeded');
    closeScheduler();
  });
});

test('a run more than 5 minutes late is recorded as missed and nothing starts', async () => {
  await withIsolatedDatabase(async () => {
    const calls: Call[] = [];
    initializeScheduler(recordingExecutor(calls), { tickMs: 0 });
    const row = schedulesDb.create(scheduleInput({ next_run_at: '2026-10-06T06:00:00.000Z' }));

    await tickSchedules(new Date('2026-10-06T09:00:00Z'));
    await settleRunningSchedules();

    assert.equal(calls.length, 0);
    const runs = scheduleRunsDb.list({ scheduleId: row.id });
    assert.equal(runs.length, 1, 'one missed run, no burst');
    assert.equal(runs[0].status, 'missed');
    assert.equal(schedulesDb.get(row.id)!.next_run_at, '2026-10-07T06:00:00.000Z');
    closeScheduler();
  });
});

test('an interval schedule that was down for hours resumes on its rhythm with one missed run', async () => {
  await withIsolatedDatabase(async () => {
    initializeScheduler(recordingExecutor([]), { tickMs: 0 });
    const row = schedulesDb.create(scheduleInput({
      schedule: JSON.stringify({ type: 'interval', every: 15, unit: 'minutes' }),
      next_run_at: '2026-10-06T06:00:00.000Z',
    }));
    await tickSchedules(new Date('2026-10-06T09:07:00Z'));
    await settleRunningSchedules();
    assert.equal(scheduleRunsDb.list({ scheduleId: row.id }).length, 1);
    assert.equal(schedulesDb.get(row.id)!.next_run_at, '2026-10-06T09:15:00.000Z');
    closeScheduler();
  });
});

test('overlapping runs are skipped while the previous one still runs', async () => {
  await withIsolatedDatabase(async () => {
    const calls: Call[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    initializeScheduler(recordingExecutor(calls, { hold }), { tickMs: 0 });
    const row = schedulesDb.create(scheduleInput());

    startRun(row, 'manual', null);
    const second = startRun(row, 'manual', null);
    assert.equal(second.status, 'skipped');
    assert.match(second.error ?? '', /still running/i);
    release();
    await settleRunningSchedules();
    assert.equal(calls.length, 1);
    closeScheduler();
  });
});

test('disabled schedules and agent proposals never run', async () => {
  await withIsolatedDatabase(async () => {
    const calls: Call[] = [];
    initializeScheduler(recordingExecutor(calls), { tickMs: 0 });
    schedulesDb.create(scheduleInput({ enabled: false, next_run_at: '2026-10-06T06:00:00.000Z' }));
    schedulesDb.create(scheduleInput({ proposal: { note: 'agent' }, next_run_at: '2026-10-06T06:00:00.000Z' }));
    await tickSchedules(new Date('2026-10-06T06:00:10Z'));
    await settleRunningSchedules();
    assert.equal(calls.length, 0);
    closeScheduler();
  });
});

test('a one-time schedule disables itself after running', async () => {
  await withIsolatedDatabase(async () => {
    initializeScheduler(recordingExecutor([]), { tickMs: 0 });
    const row = schedulesDb.create(scheduleInput({
      schedule: JSON.stringify({ type: 'once', at: '2026-10-06T06:00:00.000Z' }),
      next_run_at: '2026-10-06T06:00:00.000Z',
    }));
    await tickSchedules(new Date('2026-10-06T06:00:10Z'));
    await settleRunningSchedules();
    const after = schedulesDb.get(row.id)!;
    assert.equal(after.enabled, 0);
    assert.equal(after.next_run_at, null);
    closeScheduler();
  });
});

test('an edit made while a run is in flight survives the run finishing', async () => {
  await withIsolatedDatabase(async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    initializeScheduler(recordingExecutor([], { hold }), { tickMs: 0 });
    const row = schedulesDb.create(scheduleInput());
    startRun(row, 'manual', null);
    schedulesDb.update(row.id, { prompt: 'Edited mid-run', name: 'Renamed' });
    release();
    await settleRunningSchedules();
    const after = schedulesDb.get(row.id)!;
    assert.equal(after.prompt, 'Edited mid-run');
    assert.equal(after.name, 'Renamed');
    assert.equal(after.last_status, 'succeeded');
    closeScheduler();
  });
});

test('an executor that throws marks the run failed', async () => {
  await withIsolatedDatabase(async () => {
    initializeScheduler(async () => { throw new Error('boom'); }, { tickMs: 0 });
    const row = schedulesDb.create(scheduleInput());
    const run = startRun(row, 'manual', null);
    await settleRunningSchedules();
    const after = scheduleRunsDb.get(run.id)!;
    assert.equal(after.status, 'failed');
    assert.equal(after.error, 'boom');
    closeScheduler();
  });
});

test('startup marks runs left running as failed and plans enabled schedules without a next run', async () => {
  await withIsolatedDatabase(async () => {
    const row = schedulesDb.create(scheduleInput({ next_run_at: null }));
    scheduleRunsDb.create({ scheduleId: row.id, trigger: 'schedule', scheduledFor: null, status: 'running' });
    initializeScheduler(recordingExecutor([]), { tickMs: 0, now: () => new Date('2026-10-06T07:00:00Z') });
    assert.equal(scheduleRunsDb.list({ scheduleId: row.id })[0].status, 'failed');
    assert.equal(schedulesDb.get(row.id)!.next_run_at, '2026-10-07T06:00:00.000Z');
    closeScheduler();
  });
});

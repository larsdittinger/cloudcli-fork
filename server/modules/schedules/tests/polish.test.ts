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
import { schedulesService } from '@/modules/schedules/schedules.service.js';
import { scheduleInput, withIsolatedDatabase } from '@/modules/schedules/tests/helpers.js';

const finishOk = async (_schedule: ScheduleRow, run: ScheduleRunRow) => {
  scheduleRunsDb.finish(run.id, { status: 'succeeded', finishedAt: new Date().toISOString() });
};

test('editing only the name or prompt keeps the planned next run (no skipped run right after the due time)', async () => {
  await withIsolatedDatabase(async (dir) => {
    initializeScheduler(finishOk, { tickMs: 0 });
    const created = schedulesService.create({ name: 'A', projectPath: dir, kind: 'prompt', prompt: 'p', schedule: { type: 'interval', every: 15, unit: 'minutes' } }, null);
    // Pretend the ticker has not reached a run that was due seconds ago.
    schedulesDb.setNextRun(created.id, '2026-10-06T06:00:00.000Z');

    const renamed = schedulesService.update(created.id, { name: 'B', prompt: 'new prompt' });
    assert.equal(renamed.nextRunAt, '2026-10-06T06:00:00.000Z', 'the due run still happens and the interval keeps its rhythm');

    const rescheduled = schedulesService.update(created.id, { schedule: { type: 'daily', time: '08:00' } });
    assert.notEqual(rescheduled.nextRunAt, '2026-10-06T06:00:00.000Z', 'a new schedule is planned afresh');

    const paused = schedulesService.update(created.id, { enabled: false });
    assert.equal(paused.nextRunAt, null);
    const resumed = schedulesService.update(created.id, { enabled: true });
    assert.ok(resumed.nextRunAt && new Date(resumed.nextRunAt).getTime() > Date.now(), 'resuming plans from now, nothing old fires');
    closeScheduler();
  });
});

test('runs failed by a restart update the schedule\'s last status', async () => {
  await withIsolatedDatabase(async () => {
    const row = schedulesDb.create(scheduleInput());
    schedulesDb.recordResult(row.id, 'succeeded', '2026-10-05T06:00:00.000Z');
    scheduleRunsDb.create({ scheduleId: row.id, trigger: 'schedule', scheduledFor: null, status: 'running' });
    initializeScheduler(finishOk, { tickMs: 0 });
    assert.equal(schedulesDb.get(row.id)!.last_status, 'failed');
    closeScheduler();
  });
});

test('a one-time schedule in the past is refused', async () => {
  await withIsolatedDatabase(async (dir) => {
    initializeScheduler(finishOk, { tickMs: 0 });
    assert.throws(
      () => schedulesService.create({ name: 'Old', projectPath: dir, kind: 'prompt', prompt: 'p', schedule: { type: 'once', at: '2020-01-01T08:00:00Z' } }, null),
      /past/i,
    );
    closeScheduler();
  });
});

test('a one-time run skipped because the previous run still runs is retried instead of lost', async () => {
  await withIsolatedDatabase(async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    initializeScheduler(async (schedule, run) => { await hold; await finishOk(schedule, run); }, { tickMs: 0 });
    const row = schedulesDb.create(scheduleInput({
      schedule: JSON.stringify({ type: 'once', at: '2026-10-06T06:00:00.000Z' }),
      next_run_at: '2026-10-06T06:00:00.000Z',
    }));
    startRun(row, 'manual', null);
    await tickSchedules(new Date('2026-10-06T06:00:10Z'));
    const after = schedulesDb.get(row.id)!;
    assert.equal(after.enabled, 1, 'still enabled');
    assert.equal(after.next_run_at, '2026-10-06T06:01:10.000Z', 'retried a minute later');
    release();
    await settleRunningSchedules();
    closeScheduler();
  });
});

test('repeated skips are folded into one history row with a count', async () => {
  await withIsolatedDatabase(async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    initializeScheduler(async (schedule, run) => { await hold; await finishOk(schedule, run); }, { tickMs: 0 });
    const row = schedulesDb.create(scheduleInput());
    startRun(row, 'manual', null);
    for (let index = 0; index < 5; index += 1) startRun(row, 'schedule', null);
    const runs = scheduleRunsDb.list({ scheduleId: row.id });
    assert.equal(runs.length, 2, 'the running run and one folded skip');
    const skipped = runs.find((run) => run.status === 'skipped')!;
    assert.equal(skipped.repeat_count, 5);
    assert.equal(schedulesService.listRuns({ scheduleId: row.id }).find((run) => run.status === 'skipped')!.repeatCount, 5);
    release();
    await settleRunningSchedules();
    startRun(schedulesDb.get(row.id)!, 'manual', null);
    await settleRunningSchedules();
    closeScheduler();
  });
});

test('deleting a schedule stops its running script and removes the log', async () => {
  await withIsolatedDatabase(async (dir) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { createScheduleExecutor } = await import('@/modules/schedules/executor.service.js');
    const { fakeRuntime } = await import('@/modules/schedules/tests/helpers.js');
    const logsDir = path.join(dir, 'logs');
    initializeScheduler(createScheduleExecutor(fakeRuntime([]), { logsDir }), { tickMs: 0 });
    const marker = path.join(dir, 'still-running');
    const created = schedulesService.create({
      name: 'Long', projectPath: dir, kind: 'script', command: `sleep 2; touch ${marker}`, schedule: { type: 'daily', time: '03:00' },
    }, null);
    const run = schedulesService.runNow(created.id);
    for (let attempt = 0; attempt < 50 && !fs.existsSync(path.join(logsDir, `${run.id}.log`)); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(fs.existsSync(path.join(logsDir, `${run.id}.log`)), 'the log exists while it runs');

    schedulesService.remove(created.id);
    await settleRunningSchedules();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(fs.existsSync(marker), false, 'the script was stopped');
    assert.equal(fs.existsSync(path.join(logsDir, `${run.id}.log`)), false, 'its log is gone');
    closeScheduler();
  });
});

test('a one-time job waiting for its retry can still be renamed and duplicated', async () => {
  await withIsolatedDatabase(async (dir) => {
    initializeScheduler(finishOk, { tickMs: 0 });
    const row = schedulesDb.create(scheduleInput({
      project_path: dir,
      schedule: JSON.stringify({ type: 'once', at: '2026-10-06T06:00:00.000Z' }),
      next_run_at: '2026-10-06T06:01:10.000Z',
    }));
    const renamed = schedulesService.update(row.id, { name: 'Renamed' });
    assert.equal(renamed.name, 'Renamed');
    assert.equal(schedulesService.duplicate(row.id).enabled, false);
    assert.throws(() => schedulesService.update(row.id, { schedule: { type: 'once', at: '2020-01-01T00:00:00Z' } }), /past/i, 'a new past date is still refused');
    closeScheduler();
  });
});

test('a proposal whose one-time date has passed cannot be approved', async () => {
  await withIsolatedDatabase(async (dir) => {
    initializeScheduler(finishOk, { tickMs: 0 });
    const row = schedulesDb.create(scheduleInput({
      project_path: dir, proposal: { note: 'n' }, schedule: JSON.stringify({ type: 'once', at: '2020-01-01T08:00:00.000Z' }), next_run_at: null,
    }));
    assert.throws(() => schedulesService.approve(row.id), /passed|past/i);
    assert.ok(schedulesDb.get(row.id)!.proposal, 'still a proposal');
    closeScheduler();
  });
});

test('a skipped "Run now" is not folded into scheduled skips', async () => {
  await withIsolatedDatabase(async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    initializeScheduler(async (schedule, run) => { await hold; await finishOk(schedule, run); }, { tickMs: 0 });
    const row = schedulesDb.create(scheduleInput());
    startRun(row, 'manual', null);
    startRun(row, 'schedule', null);
    const manualSkip = startRun(row, 'manual', null);
    assert.equal(manualSkip.trigger, 'manual');
    assert.equal(manualSkip.repeat_count, 1);
    release();
    await settleRunningSchedules();
    closeScheduler();
  });
});

test('the hand-off does not start a chat for a schedule deleted while its script ran', async () => {
  await withIsolatedDatabase(async (dir) => {
    const path = await import('node:path');
    const { createScheduleExecutor } = await import('@/modules/schedules/executor.service.js');
    const { fakeRuntime } = await import('@/modules/schedules/tests/helpers.js');
    const calls: unknown[] = [];
    const row = schedulesDb.create(scheduleInput({ project_path: dir, kind: 'script', command: 'echo found', handoff: 'on_output', prompt: '{{output}}' }));
    const run = scheduleRunsDb.create({ scheduleId: row.id, trigger: 'manual', scheduledFor: null, status: 'running' });
    schedulesDb.delete(row.id);
    await createScheduleExecutor(fakeRuntime(calls as never), { logsDir: path.join(dir, 'logs') })(row, run);
    assert.equal(calls.length, 0);
  });
});

test('deleting a schedule also kills children that ignore SIGTERM', async () => {
  await withIsolatedDatabase(async (dir) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { createScheduleExecutor } = await import('@/modules/schedules/executor.service.js');
    const { fakeRuntime } = await import('@/modules/schedules/tests/helpers.js');
    const logsDir = path.join(dir, 'logs');
    initializeScheduler(createScheduleExecutor(fakeRuntime([]), { logsDir }), { tickMs: 0 });
    const marker = path.join(dir, 'survivor');
    const created = schedulesService.create({
      name: 'Stubborn', projectPath: dir, kind: 'script',
      command: `(trap '' TERM; sleep 2; touch ${marker}) & wait`, schedule: { type: 'daily', time: '03:00' },
    }, null);
    const run = schedulesService.runNow(created.id);
    for (let attempt = 0; attempt < 50 && !fs.existsSync(path.join(logsDir, `${run.id}.log`)); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    schedulesService.remove(created.id);
    await settleRunningSchedules();
    await new Promise((resolve) => setTimeout(resolve, 2600));
    assert.equal(fs.existsSync(marker), false, 'the TERM-ignoring child was killed too');
    closeScheduler();
  });
});

test('a one-time AI job whose continued chat is busy is retried, not used up', async () => {
  await withIsolatedDatabase(async (dir) => {
    const { chatRunRegistry } = await import('@/modules/websocket/index.js');
    const { createScheduleExecutor } = await import('@/modules/schedules/executor.service.js');
    const { fakeRuntime } = await import('@/modules/schedules/tests/helpers.js');
    const { sessionsDb } = await import('@/modules/database/index.js');
    sessionsDb.createAppSession('busy-chat', 'claude', dir, 't', null);
    chatRunRegistry.startRun({ appSessionId: 'busy-chat', provider: 'claude', providerSessionId: null, connection: null, userId: null } as never);
    const row = schedulesDb.create(scheduleInput({
      project_path: dir, session_mode: 'continue', schedule: JSON.stringify({ type: 'once', at: '2026-10-06T06:00:00.000Z' }), next_run_at: null,
    }));
    schedulesDb.setSessionId(row.id, 'busy-chat');
    schedulesDb.setNextRun(row.id, null, { disable: true });
    const run = scheduleRunsDb.create({ scheduleId: row.id, trigger: 'schedule', scheduledFor: '2026-10-06T06:00:00.000Z', status: 'running' });
    await createScheduleExecutor(fakeRuntime([]))(schedulesDb.get(row.id)!, run);
    const after = schedulesDb.get(row.id)!;
    assert.equal(scheduleRunsDb.get(run.id)!.status, 'skipped');
    assert.equal(after.enabled, 1, 'switched back on');
    assert.ok(after.next_run_at && new Date(after.next_run_at).getTime() > Date.now(), 'retried shortly');
  });
});

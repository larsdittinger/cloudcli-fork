import assert from 'node:assert/strict';
import test from 'node:test';

import { scheduleRunsDb, schedulesDb } from '@/modules/database/index.js';
import { scheduleInput, withIsolatedDatabase } from '@/modules/schedules/tests/helpers.js';

test('schedulesDb: create, filter by project, due excludes disabled and proposals', async () => {
  await withIsolatedDatabase(() => {
    const due = schedulesDb.create(scheduleInput({ next_run_at: '2026-10-06T06:00:00.000Z' }));
    schedulesDb.create(scheduleInput({ enabled: false, next_run_at: '2026-10-06T06:00:00.000Z' }));
    schedulesDb.create(scheduleInput({ proposal: { note: 'x' }, next_run_at: '2026-10-06T06:00:00.000Z' }));
    schedulesDb.create(scheduleInput({ project_path: '/workspace/other', next_run_at: '2026-10-09T06:00:00.000Z' }));

    assert.equal(schedulesDb.list().length, 4);
    assert.equal(schedulesDb.list({ projectPath: '/workspace/other' }).length, 1);
    assert.deepEqual(schedulesDb.listDue('2026-10-06T07:00:00.000Z').map((row) => row.id), [due.id]);
    assert.equal(schedulesDb.countProposals(), 1);

    const proposal = schedulesDb.list().find((row) => row.proposal)!;
    assert.equal(proposal.enabled, 0, 'a proposal is always stored disabled');
    const approved = schedulesDb.approve(proposal.id)!;
    assert.equal(approved.enabled, 1);
    assert.equal(approved.proposal, null);
  });
});

test('schedulesDb: recordResult only touches last_* so a concurrent edit survives', async () => {
  await withIsolatedDatabase(() => {
    const row = schedulesDb.create(scheduleInput());
    schedulesDb.update(row.id, { prompt: 'Edited while running' });
    schedulesDb.recordResult(row.id, 'succeeded', '2026-10-06T08:00:00.000Z');
    const after = schedulesDb.get(row.id)!;
    assert.equal(after.prompt, 'Edited while running');
    assert.equal(after.last_status, 'succeeded');
    assert.equal(after.last_run_at, '2026-10-06T08:00:00.000Z');

    schedulesDb.setNextRun(row.id, null, { disable: true });
    assert.equal(schedulesDb.get(row.id)!.enabled, 0);
    assert.equal(schedulesDb.get(row.id)!.next_run_at, null);
  });
});

test('scheduleRunsDb: running detection, restart cleanup, finish, prune', async () => {
  await withIsolatedDatabase(() => {
    const schedule = schedulesDb.create(scheduleInput());
    const run = scheduleRunsDb.create({ scheduleId: schedule.id, trigger: 'schedule', scheduledFor: '2026-10-06T06:00:00.000Z', status: 'running', startedAt: '2026-10-06T06:00:01.000Z' });
    assert.equal(scheduleRunsDb.isRunning(schedule.id), true);

    assert.equal(scheduleRunsDb.failRunningAfterRestart(), 1);
    const failed = scheduleRunsDb.get(run.id)!;
    assert.equal(failed.status, 'failed');
    assert.match(failed.error ?? '', /restart/i);
    assert.ok(failed.finished_at);
    assert.equal(scheduleRunsDb.isRunning(schedule.id), false);

    const second = scheduleRunsDb.create({ scheduleId: schedule.id, trigger: 'manual', scheduledFor: null, status: 'running' });
    scheduleRunsDb.finish(second.id, { status: 'succeeded', finishedAt: '2026-10-06T06:05:00.000Z', exitCode: 0, output: 'ok', logPath: '/tmp/x.log', sessionId: 's-1' });
    const finished = scheduleRunsDb.get(second.id)!;
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.session_id, 's-1');
    assert.equal(finished.output, 'ok');

    const listed = scheduleRunsDb.list({ projectPath: '/workspace/shop' });
    assert.equal(listed.length, 2);
    assert.equal(listed[0].id, second.id, 'newest first');
    assert.equal(scheduleRunsDb.list({ status: 'failed' }).length, 1);

    for (let index = 0; index < 5; index += 1) {
      scheduleRunsDb.create({ scheduleId: schedule.id, trigger: 'schedule', scheduledFor: null, status: 'missed' });
    }
    const removed = scheduleRunsDb.prune('2000-01-01T00:00:00.000Z', 3);
    assert.equal(scheduleRunsDb.list({ scheduleId: schedule.id, limit: 100 }).length, 3);
    assert.deepEqual(removed, ['/tmp/x.log'], 'pruned runs hand back their log files');

    assert.deepEqual(scheduleRunsDb.deleteForSchedule(schedule.id), []);
    assert.equal(scheduleRunsDb.list({ scheduleId: schedule.id }).length, 0);
  });
});

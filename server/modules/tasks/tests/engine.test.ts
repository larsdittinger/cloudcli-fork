import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sessionsDb, taskEventsDb, tasksDb } from '@/modules/database/index.js';
import { closeTaskEngine, initializeTaskEngine, settleTaskRuns, tickTasks } from '@/modules/tasks/engine.service.js';
import { tasksService } from '@/modules/tasks/tasks.service.js';
import { queueWake } from '@/modules/tasks/wake-queue.js';
import { fakeRuntime, withIsolatedDatabase } from '@/modules/tasks/tests/helpers.js';
import type { RuntimeCall } from '@/modules/tasks/tests/helpers.js';

const input = { title: 'Find a label printer', brief: 'Three quotes for 1000 labels.', mandate: 'Email printers.', projectPath: '/workspace/ceo_tasks' };

async function withEngine(
  onRun: ((call: RuntimeCall) => void | Promise<void>) | undefined,
  body: (calls: RuntimeCall[]) => Promise<void>,
  options: { maxRuns?: number } = {},
): Promise<void> {
  await withIsolatedDatabase(async () => {
    const calls: RuntimeCall[] = [];
    initializeTaskEngine(fakeRuntime(calls, onRun), { tickMs: 0, maxRuns: options.maxRuns ?? 2 });
    try {
      await body(calls);
    } finally {
      await settleTaskRuns();
      closeTaskEngine();
    }
  });
}

async function runAll(): Promise<void> {
  await tickTasks();
  await settleTaskRuns();
}

test('a new task starts a chat in its project with the card as the prompt', async () => {
  await withEngine(undefined, async (calls) => {
    const task = tasksService.create(input, { by: 'owner' });
    await runAll();
    assert.equal(calls.length, 1);
    assert.match(calls[0].command, /Úkol #\d+: Find a label printer/);
    assert.match(calls[0].command, /nový úkol/);

    const wake = taskEventsDb.list(task.id).find((event) => event.kind === 'wake');
    assert.ok(wake?.session_id);
    const session = sessionsDb.getSessionById(wake.session_id);
    assert.equal(session?.project_path, '/workspace/ceo_tasks');
    assert.match(String(session?.custom_name ?? ''), /^📋 #\d+ Find a label printer · /);

    const after = tasksDb.get(task.id);
    assert.equal(after?.running_session_id, null);
    assert.equal(after?.status, 'working');
  });
});

test('a run that plans nothing gets a check in 4 hours and a note, never an endless loop', async () => {
  await withEngine(undefined, async (calls) => {
    const task = tasksService.create(input, { by: 'owner' });
    const before = Date.now();
    await runAll();
    await runAll();
    assert.equal(calls.length, 1, 'no immediate second run');
    const next = Date.parse(tasksDb.get(task.id)?.next_check_at ?? '');
    assert.ok(next >= before + 4 * 60 * 60_000 - 1000 && next <= Date.now() + 4 * 60 * 60_000 + 1000);
    assert.ok(taskEventsDb.list(task.id).some((event) => event.author === 'system' && /4 h/.test(event.text)));
  });
});

test('waiting for a reply without a check date gets a follow-up in two days', async () => {
  let taskId = 0;
  await withEngine(() => { tasksService.agentUpdate(taskId, { status: 'waiting_external' }); }, async () => {
    taskId = tasksService.create(input, { by: 'owner' }).id;
    const before = Date.now();
    await runAll();
    const next = Date.parse(tasksDb.get(taskId)?.next_check_at ?? '');
    assert.ok(next >= before + 2 * 24 * 60 * 60_000 - 1000);
  });
});

test('an agent-planned check is kept and a closed task stays quiet', async () => {
  let taskId = 0;
  let step = 0;
  await withEngine(() => {
    step += 1;
    if (step === 1) tasksService.agentUpdate(taskId, { status: 'waiting_external', nextCheckInMinutes: 30 });
  }, async () => {
    taskId = tasksService.create(input, { by: 'owner' }).id;
    const before = Date.now();
    await runAll();
    const next = Date.parse(tasksDb.get(taskId)?.next_check_at ?? '');
    assert.ok(next <= before + 31 * 60_000);
    tasksService.agentUpdate(taskId, { status: 'done' });
    await runAll();
    assert.equal(step, 1);
    assert.equal(tasksDb.get(taskId)?.next_check_at, null);
  });
});

test('a message that lands during a run wakes the task again right after it, with only the new entries', async () => {
  let taskId = 0;
  let step = 0;
  await withEngine(() => {
    step += 1;
    if (step === 1) {
      taskEventsDb.add({ taskId, author: 'external', kind: 'message_in', text: 'From printer A: 4 200 Kč' });
      queueWake(taskId, 'message');
      tasksService.agentUpdate(taskId, { status: 'waiting_external', nextCheckInMinutes: 24 * 60 });
    }
  }, async (calls) => {
    taskId = tasksService.create(input, { by: 'owner' }).id;
    await runAll();
    assert.equal(calls.length, 2);
    assert.match(calls[1].command, /přišla zpráva/);
    assert.match(calls[1].command, /4 200 Kč/);
    assert.doesNotMatch(calls[1].command, /Task created\./, 'the first run already saw creation');
  });
});

test('the global limit holds back extra runs until a slot frees up', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await withEngine(async () => { await gate; }, async (calls) => {
    tasksService.create(input, { by: 'owner' });
    tasksService.create({ ...input, title: 'Second' }, { by: 'owner' });
    await tickTasks();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    release();
    await settleTaskRuns();
    assert.equal(calls.length, 2);
  }, { maxRuns: 1 });
});

test('a due check wakes the task and is used up', async () => {
  await withEngine(undefined, async (calls) => {
    const task = tasksService.create(input, { by: 'owner' });
    tasksDb.takePendingWake(task.id);
    tasksDb.update(task.id, { status: 'waiting_external', next_check_at: new Date(Date.now() - 60_000).toISOString() });
    await runAll();
    assert.equal(calls.length, 1);
    assert.match(calls[0].command, /čas kontroly/);
  });
});

test('failed runs retry in 30 minutes and after three ask the owner', async () => {
  await withEngine(() => { throw new Error('Not logged in'); }, async (calls) => {
    const task = tasksService.create(input, { by: 'owner' });
    await runAll();
    let row = tasksDb.get(task.id);
    assert.equal(row?.failure_count, 1);
    assert.ok(Date.parse(row?.next_check_at ?? '') > Date.now() + 29 * 60_000);
    assert.ok(taskEventsDb.list(task.id).some((event) => event.kind === 'run_end' && /Not logged in/.test(event.text)));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      tasksDb.update(task.id, { next_check_at: new Date(Date.now() - 1000).toISOString() });
      await runAll();
    }
    row = tasksDb.get(task.id);
    assert.equal(calls.length, 3);
    assert.equal(row?.status, 'waiting_owner');
    assert.equal(JSON.parse(row?.question ?? '{}').by, 'system');

    tasksService.answer(task.id, { option: 'Try again' });
    await runAll();
    assert.equal(calls.length, 4);
  });
});

test('more than 20 wakes in a day parks the task with the owner until they answer', async () => {
  await withEngine(undefined, async (calls) => {
    const task = tasksService.create(input, { by: 'owner' });
    for (let index = 0; index < 20; index += 1) {
      taskEventsDb.add({ taskId: task.id, author: 'system', kind: 'wake', text: 'Woke up.' });
    }
    await runAll();
    assert.equal(calls.length, 0);
    assert.equal(tasksDb.get(task.id)?.status, 'waiting_owner');

    tasksService.answer(task.id, { option: 'Continue' });
    await runAll();
    assert.equal(calls.length, 1);
  });
});

test('a restart mid-run resumes the task with a note', async () => {
  await withIsolatedDatabase(async () => {
    const calls: RuntimeCall[] = [];
    const task = tasksService.create(input, { by: 'owner' });
    tasksDb.takePendingWake(task.id);
    tasksDb.setRunning(task.id, 'old-session', new Date().toISOString());
    initializeTaskEngine(fakeRuntime(calls), { tickMs: 0 });
    try {
      await runAll();
      assert.equal(calls.length, 1);
      assert.match(calls[0].command, /restart/);
      assert.ok(taskEventsDb.list(task.id).some((event) => /restart/i.test(event.text) && event.kind === 'run_end'));
    } finally {
      await settleTaskRuns();
      closeTaskEngine();
    }
  });
});

test('deleting a task mid-run ends quietly', async () => {
  let taskId = 0;
  await withEngine(() => { tasksService.remove(taskId); }, async (calls) => {
    taskId = tasksService.create(input, { by: 'owner' }).id;
    await runAll();
    await runAll();
    assert.equal(calls.length, 1);
    assert.equal(tasksDb.get(taskId), null);
  });
});

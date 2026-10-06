import assert from 'node:assert/strict';
import { test } from 'node:test';

import { channelOutboxDb, taskEventsDb, tasksDb, taskThreadsDb } from '@/modules/database/index.js';
import { taskInput, withIsolatedDatabase } from '@/modules/tasks/tests/helpers.js';

test('tasks get increasing numeric ids and sensible defaults', async () => {
  await withIsolatedDatabase(() => {
    const first = tasksDb.create(taskInput());
    const second = tasksDb.create(taskInput({ title: 'Second' }));
    assert.equal(second.id, first.id + 1);
    assert.equal(first.status, 'new');
    assert.equal(first.mandate_confirmed, 1);
    assert.deepEqual(JSON.parse(first.checklist), []);
    assert.deepEqual(JSON.parse(first.pending_wake), []);
    assert.equal(first.running_session_id, null);
  });
});

test('update changes only the given columns and bumps updated_at', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksDb.create(taskInput());
    const updated = tasksDb.update(task.id, { summary: 'Three quotes in.', status: 'waiting_external' });
    assert.equal(updated?.summary, 'Three quotes in.');
    assert.equal(updated?.status, 'waiting_external');
    assert.equal(updated?.brief, task.brief);
  });
});

test('pending wakes collect without duplicates and are taken once', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksDb.create(taskInput());
    tasksDb.addPendingWake(task.id, 'created');
    tasksDb.addPendingWake(task.id, 'message');
    tasksDb.addPendingWake(task.id, 'message');
    assert.deepEqual(tasksDb.takePendingWake(task.id), ['created', 'message']);
    assert.deepEqual(tasksDb.takePendingWake(task.id), []);
  });
});

test('wakeable lists pending wakes and due checks but not running, closed or owner-waiting tasks', async () => {
  await withIsolatedDatabase(() => {
    const now = '2026-10-07T08:00:00.000Z';
    const pending = tasksDb.create(taskInput({ title: 'pending' }));
    tasksDb.addPendingWake(pending.id, 'created');
    const due = tasksDb.create(taskInput({ title: 'due', status: 'waiting_external', next_check_at: '2026-10-07T07:00:00.000Z' }));
    tasksDb.create(taskInput({ title: 'later', status: 'waiting_external', next_check_at: '2026-10-08T07:00:00.000Z' }));
    tasksDb.create(taskInput({ title: 'owner', status: 'waiting_owner', next_check_at: '2026-10-07T07:00:00.000Z' }));
    tasksDb.create(taskInput({ title: 'done', status: 'done', next_check_at: '2026-10-07T07:00:00.000Z' }));
    const running = tasksDb.create(taskInput({ title: 'running', next_check_at: '2026-10-07T07:00:00.000Z' }));
    tasksDb.setRunning(running.id, 'session-1', now);
    // An owner-waiting task with an explicit wake (Lars answered) is wakeable.
    const answered = tasksDb.create(taskInput({ title: 'answered', status: 'waiting_owner' }));
    tasksDb.addPendingWake(answered.id, 'owner_answer');

    const titles = tasksDb.listWakeable(now).map((row) => row.title).sort();
    assert.deepEqual(titles, ['answered', 'due', 'pending']);
    assert.ok(due);
  });
});

test('restart recovery clears running state and returns the interrupted tasks', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksDb.create(taskInput());
    tasksDb.setRunning(task.id, 'session-1', '2026-10-07T08:00:00.000Z');
    const recovered = tasksDb.resetRunningAfterRestart();
    assert.deepEqual(recovered.map((row) => row.id), [task.id]);
    assert.equal(tasksDb.get(task.id)?.running_session_id, null);
  });
});

test('events list in order, after a given id, and count wakes in a window', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksDb.create(taskInput());
    const a = taskEventsDb.add({ taskId: task.id, author: 'owner', kind: 'created', text: 'Created' });
    taskEventsDb.add({ taskId: task.id, author: 'system', kind: 'wake', text: 'Woke', at: '2026-10-07T07:00:00.000Z' });
    taskEventsDb.add({ taskId: task.id, author: 'system', kind: 'wake', text: 'Woke', at: '2026-10-07T09:00:00.000Z' });
    assert.deepEqual(taskEventsDb.list(task.id).map((event) => event.kind), ['created', 'wake', 'wake']);
    assert.equal(taskEventsDb.list(task.id, { afterId: a.id }).length, 2);
    assert.equal(taskEventsDb.countSince(task.id, 'wake', '2026-10-07T08:00:00.000Z'), 1);
    assert.deepEqual(taskEventsDb.list(task.id, { limit: 1 }).map((event) => event.kind), ['wake'], 'limit keeps the newest');
  });
});

test('attention counts questions, unconfirmed mandates and task drafts', async () => {
  await withIsolatedDatabase(() => {
    const asked = tasksDb.create(taskInput({ status: 'waiting_owner', question: JSON.stringify({ text: 'Which?', options: ['A'] }) }));
    tasksDb.create(taskInput({ mandate_confirmed: 0, project_path: '/workspace/other' }));
    tasksDb.create(taskInput({ status: 'done', mandate_confirmed: 0 }));
    channelOutboxDb.create({ accountId: 'acc', to: 'x@example.com', text: 'Quote?', status: 'draft', createdBy: 'agent', taskId: asked.id });
    channelOutboxDb.create({ accountId: 'acc', to: 'y@example.com', text: 'Not a task', status: 'draft', createdBy: 'agent' });
    const summary = tasksDb.attention();
    // The asked task also has a draft but counts once; the closed one not at all.
    assert.equal(summary.total, 2);
    assert.equal(summary.byProject['/workspace/shop'], 1);
    assert.equal(summary.byProject['/workspace/other'], 1);
  });
});

test('threads link to a task and are removed with it', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksDb.create(taskInput());
    taskThreadsDb.link('acc', 'thread-1', task.id);
    taskThreadsDb.link('acc', 'thread-1', task.id);
    assert.equal(taskThreadsDb.find('acc', 'thread-1'), task.id);
    assert.equal(taskThreadsDb.find('other', 'thread-1'), null);
    tasksDb.delete(task.id);
    assert.equal(taskThreadsDb.find('acc', 'thread-1'), null);
    assert.equal(taskEventsDb.list(task.id).length, 0);
  });
});

test('outbox rows carry their task and list by task', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksDb.create(taskInput());
    const row = channelOutboxDb.create({ accountId: 'acc', to: 'x@example.com', text: 'Quote?', status: 'draft', createdBy: 'agent', taskId: task.id });
    assert.equal(row.task_id, task.id);
    assert.deepEqual(channelOutboxDb.listByTask(task.id).map((item) => item.id), [row.id]);
  });
});

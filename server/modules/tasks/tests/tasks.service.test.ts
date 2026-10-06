import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';

import { channelOutboxDb, taskEventsDb, tasksDb } from '@/modules/database/index.js';
import { renderWakePrompt } from '@/modules/tasks/task-prompt.js';
import { tasksService } from '@/modules/tasks/tasks.service.js';
import { withIsolatedDatabase } from '@/modules/tasks/tests/helpers.js';

/** An existing directory: agents may only create tasks in real project folders. */
const AGENT_DIR = tmpdir();

const ownerInput = {
  title: 'Find a label printer',
  brief: 'Three printers, prices for 1000 labels.',
  mandate: 'May email up to 5 printers. No orders.',
  projectPath: '/workspace/ceo_tasks',
};

function expectStatus(fn: () => unknown, statusCode: number) {
  assert.throws(fn, (error: { statusCode?: number }) => error.statusCode === statusCode);
}

test('an owner task starts confirmed, logged and queued to wake', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksService.create(ownerInput, { by: 'owner', userId: 1 });
    assert.equal(task.mandateConfirmed, true);
    assert.equal(task.status, 'new');
    assert.equal(task.ownerUserId, 1);
    assert.deepEqual(tasksDb.get(task.id)?.pending_wake, '["created"]');
    assert.deepEqual(taskEventsDb.list(task.id).map((event) => [event.author, event.kind]), [['owner', 'created']]);
  });
});

test('an agent task needs the owner to confirm its mandate and defaults to the agent project', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksService.create({ title: 'Ask printers', brief: 'Prices', mandate: 'Email printers' }, { by: 'agent', cwd: AGENT_DIR });
    assert.equal(task.mandateConfirmed, false);
    assert.equal(task.createdBy, 'agent');
    assert.equal(task.projectPath, AGENT_DIR);
    const confirmed = tasksService.confirmMandate(task.id);
    assert.equal(confirmed.mandateConfirmed, true);
    assert.ok(tasksDb.get(task.id)?.pending_wake.includes('mandate_confirmed'));
  });
});

test('creation validates title, brief and an absolute project path', async () => {
  await withIsolatedDatabase(() => {
    expectStatus(() => tasksService.create({ ...ownerInput, title: '  ' }, { by: 'owner' }), 400);
    expectStatus(() => tasksService.create({ ...ownerInput, brief: '' }, { by: 'owner' }), 400);
    expectStatus(() => tasksService.create({ ...ownerInput, projectPath: 'relative/dir' }, { by: 'owner' }), 400);
    expectStatus(() => tasksService.create({ ...ownerInput, permissionMode: 'yolo' }, { by: 'owner' }), 400);
  });
});

test('a question parks the task with the owner; an answer resumes it', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksService.create(ownerInput, { by: 'owner' });
    tasksDb.takePendingWake(task.id);
    const asked = tasksService.ask(task.id, { question: 'Which printer?', options: ['Tiskárna A', 'Tiskárna B'] });
    assert.equal(asked.status, 'waiting_owner');
    assert.deepEqual(asked.question?.options, ['Tiskárna A', 'Tiskárna B']);

    const answered = tasksService.answer(task.id, { option: 'Tiskárna B', text: 'ale vyjednej dopravu' });
    assert.equal(answered.status, 'working');
    assert.equal(answered.question, null);
    assert.deepEqual(JSON.parse(tasksDb.get(task.id)?.pending_wake ?? '[]'), ['owner_answer']);
    const answer = taskEventsDb.list(task.id).at(-1);
    assert.equal(answer?.kind, 'answer');
    assert.match(answer?.text ?? '', /Tiskárna B/);
    assert.match(answer?.text ?? '', /dopravu/);
    expectStatus(() => tasksService.answer(task.id, { option: 'again' }), 409);
  });
});

test('questions need text and at most six short options', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksService.create(ownerInput, { by: 'owner' });
    expectStatus(() => tasksService.ask(task.id, { question: '', options: [] }), 400);
    expectStatus(() => tasksService.ask(task.id, { question: 'Pick', options: ['1', '2', '3', '4', '5', '6', '7'] }), 400);
  });
});

test('agents cannot park a task with the owner by status, and closing clears its plans', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksService.create(ownerInput, { by: 'owner' });
    expectStatus(() => tasksService.agentUpdate(task.id, { status: 'waiting_owner' }), 400);
    tasksService.agentUpdate(task.id, { status: 'waiting_external', nextCheckInMinutes: 60 });
    tasksDb.addPendingWake(task.id, 'message');
    const done = tasksService.agentUpdate(task.id, { status: 'done', summary: 'Ordered nothing, recommended B.' });
    assert.equal(done.status, 'done');
    assert.ok(done.closedAt);
    assert.equal(done.nextCheckAt, null);
    assert.equal(tasksDb.get(task.id)?.pending_wake, '[]');
    expectStatus(() => tasksService.agentUpdate(task.id, { summary: 'more' }), 409);
    // A closing note is still welcome.
    tasksService.log(task.id, 'Final note.');
  });
});

test('next check accepts minutes or a date, never more than 90 days out', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksService.create(ownerInput, { by: 'owner' });
    const before = Date.now();
    const inHour = tasksService.agentUpdate(task.id, { nextCheckInMinutes: 60 });
    const at = Date.parse(inHour.nextCheckAt ?? '');
    assert.ok(at >= before + 59 * 60_000 && at <= Date.now() + 61 * 60_000);
    const inTenDays = new Date(Date.now() + 10 * 24 * 60 * 60_000).toISOString();
    const exact = tasksService.agentUpdate(task.id, { nextCheckAt: inTenDays });
    assert.equal(exact.nextCheckAt, inTenDays);
    // A time in the past means "as soon as possible", not an error.
    const past = tasksService.agentUpdate(task.id, { nextCheckAt: '2020-01-01T08:00:00.000Z' });
    assert.ok(Date.parse(past.nextCheckAt ?? '') >= before);
    expectStatus(() => tasksService.agentUpdate(task.id, { nextCheckInMinutes: 91 * 24 * 60 }), 400);
    expectStatus(() => tasksService.agentUpdate(task.id, { nextCheckAt: 'tomorrow-ish' }), 400);
  });
});

test('checklists are validated and stored', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksService.create(ownerInput, { by: 'owner' });
    const updated = tasksService.agentUpdate(task.id, { checklist: [{ text: 'Find printers', done: true }, { text: 'Ask for quotes', done: false }] });
    assert.deepEqual(updated.checklist, [{ text: 'Find printers', done: true }, { text: 'Ask for quotes', done: false }]);
    expectStatus(() => tasksService.agentUpdate(task.id, { checklist: [{ text: '', done: false }] }), 400);
    expectStatus(() => tasksService.agentUpdate(task.id, { checklist: 'nope' as never }), 400);
  });
});

test('owner comments wake an open task but not a closed one; reopening wakes it', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksService.create(ownerInput, { by: 'owner' });
    tasksDb.takePendingWake(task.id);
    tasksService.comment(task.id, 'Prefer local printers.');
    assert.deepEqual(tasksService.get(task.id).task.pendingWake, ['owner_comment']);
    tasksDb.takePendingWake(task.id);

    tasksService.setStatus(task.id, 'cancelled');
    tasksService.comment(task.id, 'Just a note.');
    assert.deepEqual(tasksService.get(task.id).task.pendingWake, []);

    const reopened = tasksService.setStatus(task.id, 'working');
    assert.equal(reopened.closedAt, null);
    assert.deepEqual(reopened.pendingWake, ['reopened']);
  });
});

test('owner edits keep the mandate confirmed and are logged', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksService.create({ title: 'T', brief: 'B', mandate: 'M' }, { by: 'agent', cwd: AGENT_DIR });
    const edited = tasksService.updateByOwner(task.id, { mandate: 'Email at most 3 printers.' });
    assert.equal(edited.mandateConfirmed, true);
    assert.equal(edited.mandate, 'Email at most 3 printers.');
    assert.ok(taskEventsDb.list(task.id).some((event) => event.kind === 'mandate'));
  });
});

test('deleting a task discards its unsent drafts', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksService.create(ownerInput, { by: 'owner' });
    const draft = channelOutboxDb.create({ accountId: 'acc', to: 'a@example.com', text: 'Quote?', status: 'draft', createdBy: 'agent', taskId: task.id });
    tasksService.remove(task.id);
    assert.equal(tasksDb.get(task.id), null);
    assert.equal(channelOutboxDb.get(draft.id)?.status, 'discarded');
    expectStatus(() => tasksService.get(task.id), 404);
  });
});

test('the wake prompt carries the card, reasons and only the new diary entries', async () => {
  await withIsolatedDatabase(() => {
    const created = tasksService.create({ title: 'Ask printers', brief: 'Get three quotes.', mandate: 'Email printers' }, { by: 'agent', cwd: AGENT_DIR });
    tasksService.agentUpdate(created.id, { summary: 'Asked A and B.', checklist: [{ text: 'Ask A', done: true }] });
    const seen = taskEventsDb.latestId(created.id);
    tasksDb.update(created.id, { seen_event_id: seen });
    taskEventsDb.add({ taskId: created.id, author: 'external', kind: 'message_in', text: 'From a@print.cz: 1000 ks = 4 200 Kč' });
    tasksService.comment(created.id, 'Ask about delivery too.');

    const row = tasksDb.get(created.id);
    assert.ok(row);
    const prompt = renderWakePrompt(row, ['message', 'owner_comment'], taskEventsDb.list(created.id, { afterId: seen }), seen);
    assert.match(prompt, /#\d+/);
    assert.match(prompt, /Ask printers/);
    assert.match(prompt, /přišla zpráva/);
    assert.match(prompt, /NEPOTVRZENÝ/);
    assert.match(prompt, /Asked A and B\./);
    assert.match(prompt, /\[x\] Ask A/);
    assert.match(prompt, /4 200 Kč/);
    assert.match(prompt, /Ask about delivery too\./);
    assert.doesNotMatch(prompt, /\] Lars: Created|created the task/i, 'older entries stay out');
    assert.match(prompt, /tasks_get/);
  });
});

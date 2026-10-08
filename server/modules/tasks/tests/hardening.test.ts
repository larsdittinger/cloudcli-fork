import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';

import { taskEventsDb, tasksDb } from '@/modules/database/index.js';
import { closeTaskEngine, initializeTaskEngine, settleTaskRuns, tickTasks } from '@/modules/tasks/engine.service.js';
import { setTaskNotifierForTests } from '@/modules/tasks/owner-notify.service.js';
import type { TaskNotice } from '@/modules/tasks/owner-notify.service.js';
import { tasksService } from '@/modules/tasks/tasks.service.js';
import { withIsolatedDatabase } from '@/modules/tasks/tests/helpers.js';

/** An existing directory: agents may only create tasks in real project folders. */
const AGENT_DIR = tmpdir();
const input = { title: 'Find a label printer', brief: 'Three quotes for 1000 labels.', mandate: 'Email printers.', projectPath: '/workspace/ceo_tasks' };

type Writer = { send: (data: unknown) => void };
type Turn = { command: string; writer: Writer };

/** A runtime whose turns the test plays: `onRun` writes the chat events the agent would produce. */
async function withEngine(onRun: (turn: Turn, index: number) => void | Promise<void>, body: (turns: Turn[]) => Promise<void>): Promise<void> {
  await withIsolatedDatabase(async () => {
    const turns: Turn[] = [];
    const runtime = {
      hasRuntime: () => true,
      run: async (_provider: string, command: string, _options: Record<string, unknown>, writer: Writer) => {
        const turn = { command, writer };
        turns.push(turn);
        await onRun(turn, turns.length - 1);
      },
      abort: async () => true,
    } as never;
    initializeTaskEngine(runtime, { tickMs: 0, maxRuns: 2 });
    try {
      await body(turns);
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

function makeDue(taskId: number): void {
  tasksDb.update(taskId, { next_check_at: new Date(Date.now() - 1000).toISOString() });
}

test('a usage limit is no failure: the task waits for the reset and sees the same news again', async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 2 * 3600;
  await withEngine((turn, index) => {
    if (index === 0) turn.writer.send({ kind: 'text', content: `Claude AI usage limit reached|${resetAt}`, provider: 'claude' });
    turn.writer.send({ kind: 'complete', exitCode: 0, provider: 'claude' });
  }, async (turns) => {
    const task = tasksService.create(input, { by: 'owner' });
    tasksService.comment(task.id, 'Prefer printers in Brno.');
    await runAll();
    const row = tasksDb.get(task.id);
    assert.equal(row?.failure_count, 0);
    assert.equal(row?.next_check_at, new Date(resetAt * 1000).toISOString());
    assert.ok(taskEventsDb.list(task.id).some((event) => event.kind === 'run_end' && /usage limit/i.test(event.text)));

    // Nothing of that provider starts before the reset, even when asked to.
    tasksService.wakeNow(task.id);
    await runAll();
    assert.equal(turns.length, 1);

    await tickTasks(new Date(resetAt * 1000 + 1000));
    await settleTaskRuns();
    assert.equal(turns.length, 2);
    assert.match(turns[1].command, /Prefer printers in Brno/, 'the comment the limited run never read is shown again');
    assert.match(turns[1].command, /nový úkol/, 'and the reason it first woke for');
  });
});

test('a limit reported as an error without a reset time retries in an hour', async () => {
  await withEngine((turn) => {
    turn.writer.send({ kind: 'error', content: "You've hit your usage limit. Try again later.", provider: 'codex' });
    turn.writer.send({ kind: 'complete', exitCode: 1, provider: 'codex' });
  }, async () => {
    const task = tasksService.create(input, { by: 'owner' });
    const before = Date.now();
    await runAll();
    const row = tasksDb.get(task.id);
    assert.equal(row?.failure_count, 0);
    const next = Date.parse(row?.next_check_at ?? '');
    assert.ok(next >= before + 59 * 60_000 && next <= Date.now() + 61 * 60_000);
  });
});

test('a run that used tools is never mistaken for a limit by its wording', async () => {
  await withEngine((turn) => {
    turn.writer.send({ kind: 'tool_use', toolName: 'WebFetch', toolInput: {}, provider: 'claude' });
    turn.writer.send({ kind: 'text', content: 'The supplier API said: rate limit reached, I will retry tomorrow.', provider: 'claude' });
    turn.writer.send({ kind: 'complete', exitCode: 0, provider: 'claude' });
  }, async () => {
    const task = tasksService.create(input, { by: 'owner' });
    await runAll();
    assert.ok(taskEventsDb.list(task.id).every((event) => !/usage limit/i.test(event.text)));
  });
});

test('a failed run shows the news it missed to the retry', async () => {
  await withEngine((turn, index) => {
    if (index === 0) throw new Error('Not logged in');
    turn.writer.send({ kind: 'complete', exitCode: 0, provider: 'claude' });
  }, async (turns) => {
    const task = tasksService.create(input, { by: 'owner' });
    tasksService.comment(task.id, 'Budget is 5000 CZK.');
    await runAll();
    assert.equal(tasksDb.get(task.id)?.failure_count, 1);
    makeDue(task.id);
    await runAll();
    assert.match(turns[1].command, /Budget is 5000 CZK/);
  });
});

test('a task created during another task\'s run waits for the owner instead of starting', async () => {
  await withEngine(async (turn, index) => {
    if (index === 0) {
      const child = tasksService.create({ title: 'Sub-task', brief: 'Ask a second printer.', mandate: '' }, { by: 'agent', cwd: AGENT_DIR });
      assert.equal(child.status, 'waiting_owner');
      assert.equal(child.question?.by, 'system');
      assert.match(child.question?.text ?? '', /waits for you/i);
    }
    turn.writer.send({ kind: 'complete', exitCode: 0, provider: 'claude' });
  }, async (turns) => {
    const parent = tasksService.create({ ...input, projectPath: AGENT_DIR }, { by: 'owner' });
    await runAll();
    assert.equal(turns.length, 1, 'the proposed task did not start');
    const child = tasksService.list().find((task) => task.id !== parent.id);
    assert.ok(child);

    tasksService.answer(child.id, { option: 'Start' });
    await runAll();
    assert.equal(turns.length, 2);
    assert.match(turns[1].command, /Sub-task/);
  });
});

test('an agent outside any task run still creates a task that starts', async () => {
  await withEngine((turn) => {
    turn.writer.send({ kind: 'complete', exitCode: 0, provider: 'claude' });
  }, async (turns) => {
    const task = tasksService.create({ title: 'Handoff', brief: 'Long work.', mandate: '' }, { by: 'agent', cwd: AGENT_DIR });
    assert.equal(task.status, 'new');
    await runAll();
    assert.equal(turns.length, 1);
  });
});

test('the owner is notified when a task asks, waits for a mandate, or ends', async () => {
  const notices: TaskNotice[] = [];
  setTaskNotifierForTests((notice) => { notices.push(notice); });
  try {
    await withIsolatedDatabase(async () => {
      const task = tasksService.create(input, { by: 'owner' });
      assert.equal(notices.length, 0, 'the owner creating a task needs no ping');
      tasksService.ask(task.id, { question: 'Which printer?', options: ['A', 'B'] });
      assert.equal(notices.at(-1)?.taskId, task.id);
      assert.match(notices.at(-1)?.message ?? '', /Which printer\?/);
      assert.equal(notices.at(-1)?.needsAction, true);

      tasksService.answer(task.id, { option: 'A' });
      tasksService.agentUpdate(task.id, { status: 'done', summary: 'Ordered from A.' });
      assert.match(notices.at(-1)?.message ?? '', /done/i);
      assert.equal(notices.at(-1)?.needsAction, false);

      const agentTask = tasksService.create({ title: 'Agent idea', brief: 'Something.', mandate: 'Email people.' }, { by: 'agent', cwd: AGENT_DIR });
      assert.equal(notices.at(-1)?.taskId, agentTask.id);
      assert.match(notices.at(-1)?.message ?? '', /mandate/i);
    });
  } finally {
    setTaskNotifierForTests(null);
  }
});

test('a summary over the limit is refused with a request to condense it', async () => {
  await withIsolatedDatabase(async () => {
    const task = tasksService.create(input, { by: 'owner' });
    assert.throws(() => tasksService.agentUpdate(task.id, { summary: 'x'.repeat(4001) }), /condense/i);
    assert.doesNotThrow(() => tasksService.agentUpdate(task.id, { summary: 'x'.repeat(4000) }));
  });
});

test('a run that did work before failing does not get its news again', async () => {
  await withEngine((turn, index) => {
    if (index === 0) {
      turn.writer.send({ kind: 'tool_use', toolName: 'mcp__cloudcli-tasks__tasks_send_message', toolInput: {}, provider: 'claude' });
      turn.writer.send({ kind: 'error', content: 'API Error: 500 overloaded', provider: 'claude' });
    }
    turn.writer.send({ kind: 'complete', exitCode: 0, provider: 'claude' });
  }, async (turns) => {
    const task = tasksService.create(input, { by: 'owner' });
    tasksService.comment(task.id, 'Order the cheapest one.');
    await runAll();
    assert.equal(tasksDb.get(task.id)?.failure_count, 1);
    makeDue(task.id);
    await runAll();
    assert.doesNotMatch(turns[1].command, /Order the cheapest one/, 'acted-on news is not replayed');
  });
});

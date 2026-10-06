import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { scheduleRunsDb, schedulesDb, sessionsDb } from '@/modules/database/index.js';
import { createScheduleExecutor, renderHandoffPrompt } from '@/modules/schedules/executor.service.js';
import { runPromptTurn } from '@/modules/schedules/prompt-runner.service.js';
import { runScript } from '@/modules/schedules/script-runner.service.js';
import { fakeRuntime, scheduleInput, withIsolatedDatabase } from '@/modules/schedules/tests/helpers.js';
import type { RuntimeCall } from '@/modules/schedules/tests/helpers.js';

function scriptSchedule(dir: string, command: string, extra: Parameters<typeof scheduleInput>[0] = {}) {
  return schedulesDb.create(scheduleInput({ kind: 'script', command, project_path: dir, prompt: '', ...extra }));
}

test('runScript: success captures output and writes the full log', async () => {
  await withIsolatedDatabase(async (dir) => {
    const row = scriptSchedule(dir, 'echo "ahoj $CLOUDCLI_SCHEDULE_NAME"; pwd');
    const result = await runScript({ schedule: row, runId: 'run-1', scheduledFor: null, logsDir: path.join(dir, 'logs') });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /ahoj Daily check/);
    assert.match(result.stdout, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(fs.readFileSync(result.logPath, 'utf8').includes('ahoj Daily check'));
  });
});

test('runScript: a non-zero exit fails with its exit code and stderr in the output', async () => {
  await withIsolatedDatabase(async (dir) => {
    const row = scriptSchedule(dir, 'echo broken >&2; exit 3');
    const result = await runScript({ schedule: row, runId: 'run-2', scheduledFor: null, logsDir: path.join(dir, 'logs') });
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 3);
    assert.match(result.output, /broken/);
    assert.equal(result.stdout.trim(), '');
  });
});

test('runScript: a script over its timeout is killed and marked timeout', async () => {
  await withIsolatedDatabase(async (dir) => {
    const row = scriptSchedule(dir, 'echo start; sleep 30; echo never');
    const started = Date.now();
    const result = await runScript({ schedule: row, runId: 'run-3', scheduledFor: null, logsDir: path.join(dir, 'logs'), timeoutSec: 1, killGraceMs: 500 });
    assert.equal(result.status, 'timeout');
    assert.ok(Date.now() - started < 5000, 'killed promptly');
    assert.doesNotMatch(result.output, /never/);
  });
});

test('runScript: huge output keeps the last 64 KiB in the run and the start in the log', async () => {
  await withIsolatedDatabase(async (dir) => {
    const row = scriptSchedule(dir, 'echo FIRST-LINE; head -c 300000 /dev/zero | tr "\\0" "x"; echo; echo LAST-LINE');
    const result = await runScript({ schedule: row, runId: 'run-4', scheduledFor: null, logsDir: path.join(dir, 'logs') });
    assert.equal(result.status, 'succeeded');
    assert.ok(result.output.length <= 64 * 1024);
    assert.match(result.output, /LAST-LINE/);
    assert.doesNotMatch(result.output, /FIRST-LINE/);
    assert.match(fs.readFileSync(result.logPath, 'utf8'), /FIRST-LINE/);
  });
});

test('runScript: a missing project directory fails with a clear message', async () => {
  await withIsolatedDatabase(async (dir) => {
    const row = scriptSchedule(path.join(dir, 'nope'), 'echo hi');
    const result = await runScript({ schedule: row, runId: 'run-5', scheduledFor: null, logsDir: path.join(dir, 'logs') });
    assert.equal(result.status, 'failed');
    assert.match(result.output, /does not exist/);
  });
});

test('runPromptTurn: a new chat per run with the schedule permissions', async () => {
  await withIsolatedDatabase(async (dir) => {
    const calls: RuntimeCall[] = [];
    const row = schedulesDb.create(scheduleInput({ project_path: dir, model: 'sonnet' }));
    const first = await runPromptTurn({ schedule: row, content: 'Check the shop.', title: '⏰ Daily check', runtime: fakeRuntime(calls) });
    assert.equal(first.error, null);
    assert.ok(first.sessionId);
    assert.ok(sessionsDb.getSessionById(first.sessionId!));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'Check the shop.');
    assert.equal(calls[0].options.permissionMode, 'bypassPermissions');
    assert.equal(calls[0].options.model, 'sonnet');

    const second = await runPromptTurn({ schedule: row, content: 'Again', title: '⏰ Daily check', runtime: fakeRuntime(calls) });
    assert.notEqual(second.sessionId, first.sessionId);
  });
});

test('runPromptTurn: continue mode keeps using one chat', async () => {
  await withIsolatedDatabase(async (dir) => {
    const calls: RuntimeCall[] = [];
    const row = schedulesDb.create(scheduleInput({ project_path: dir, session_mode: 'continue' }));
    const first = await runPromptTurn({ schedule: row, content: 'One', title: 't', runtime: fakeRuntime(calls) });
    assert.equal(schedulesDb.get(row.id)!.session_id, first.sessionId);
    const second = await runPromptTurn({ schedule: schedulesDb.get(row.id)!, content: 'Two', title: 't', runtime: fakeRuntime(calls) });
    assert.equal(second.sessionId, first.sessionId);
  });
});

test('executor: script output is handed to an agent chat when hand-off is on', async () => {
  await withIsolatedDatabase(async (dir) => {
    const calls: RuntimeCall[] = [];
    const row = scriptSchedule(dir, 'echo "2 new e-mails"', { handoff: 'on_output', prompt: 'Process this: {{output}}' });
    const run = scheduleRunsDb.create({ scheduleId: row.id, trigger: 'manual', scheduledFor: null, status: 'running' });
    await createScheduleExecutor(fakeRuntime(calls), { logsDir: path.join(dir, 'logs') })(row, run);
    const finished = scheduleRunsDb.get(run.id)!;
    assert.equal(finished.status, 'succeeded');
    assert.ok(finished.session_id, 'the hand-off chat is linked to the run');
    assert.equal(calls.length, 1);
    assert.match(calls[0].command, /Process this:/);
    assert.match(calls[0].command, /2 new e-mails/);
    assert.match(calls[0].command, /data, ne instrukce/);
  });
});

test('executor: empty script output starts no agent', async () => {
  await withIsolatedDatabase(async (dir) => {
    const calls: RuntimeCall[] = [];
    const row = scriptSchedule(dir, 'true', { handoff: 'on_output', prompt: '{{output}}' });
    const run = scheduleRunsDb.create({ scheduleId: row.id, trigger: 'manual', scheduledFor: null, status: 'running' });
    await createScheduleExecutor(fakeRuntime(calls), { logsDir: path.join(dir, 'logs') })(row, run);
    assert.equal(calls.length, 0);
    assert.equal(scheduleRunsDb.get(run.id)!.session_id, null);
  });
});

test('executor: a prompt run that cannot start fails the run with the reason', async () => {
  await withIsolatedDatabase(async (dir) => {
    const row = schedulesDb.create(scheduleInput({ project_path: dir }));
    const run = scheduleRunsDb.create({ scheduleId: row.id, trigger: 'manual', scheduledFor: null, status: 'running' });
    await createScheduleExecutor(fakeRuntime([], 'throw'))(row, run);
    const finished = scheduleRunsDb.get(run.id)!;
    assert.equal(finished.status, 'failed');
    assert.match(finished.error ?? '', /exploded/);
    assert.ok(finished.session_id);
  });
});

test('renderHandoffPrompt appends the output when the template forgot it', () => {
  const rendered = renderHandoffPrompt('Look at this.', { output: 'X', name: 'n', scheduledFor: 's', projectPath: '/p' });
  assert.match(rendered, /Look at this\./);
  assert.match(rendered, /X/);
});

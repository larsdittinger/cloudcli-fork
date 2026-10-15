import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  abortClaudeSDKSession,
  isClaudeSDKSessionMidTurn,
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
  stopClaudeSDKTask,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The runtime keeps the CLI's stdin open after a turn's `result` while the
 * turn's background work is outstanding, and lets go when that work has
 * reported. These drive `queryClaudeSDK` with a scripted SDK stream — the
 * seam is `context.createQuery` — and watch the held prompt stream: the CLI
 * exits when it ends, so "released" is the whole outcome.
 */

const SESSION_ID = 'app-hold-session';
const NATIVE_ID = 'native-hold-session';

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  released: () => boolean;
  stopped: string[];
  /** How many times the runtime asked the CLI to interrupt. */
  interrupts: () => number;
  /** Whether the runtime ended the process (`query.close()`). */
  closed: () => boolean;
  /** Makes interrupt() never answer, like a request the SDK dropped on an ended stdin. */
  hangInterrupts: () => void;
};

const PROCESS_KILLED = Symbol('process killed');

/** A stand-in for the SDK query: yields what the test emits, and reads the held prompt to notice its release. */
function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<Record<string, unknown> | null | typeof PROCESS_KILLED> = [];
  let wake: (() => void) | null = null;
  let released = false;
  const stopped: string[] = [];
  let interrupts = 0;
  let closed = false;
  let interruptsHang = false;

  const script: Scripted = {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    released: () => released,
    stopped,
    interrupts: () => interrupts,
    closed: () => closed,
    hangInterrupts: () => { interruptsHang = true; },
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    void (async () => {
      for await (const _message of prompt) { /* the CLI reads its stdin */ }
      released = true;
    })();

    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === PROCESS_KILLED) {
          throw new Error('Claude Code process exited with code 143');
        }
        if (next === null || next === undefined) {
          return;
        }
        yield next;
      }
    })();

    return Object.assign(iterator, {
      interrupt: () => {
        interrupts += 1;
        return interruptsHang ? new Promise<void>(() => {}) : Promise.resolve();
      },
      stopTask: async (taskId: string) => { stopped.push(taskId); },
      close: () => {
        closed = true;
        queue.push(PROCESS_KILLED);
        wake?.();
      },
    });
  };

  return { createQuery, script };
}

async function withRun(
  runTest: (context: { script: Scripted; sent: NormalizedMessage[]; done: Promise<unknown> }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };

  try {
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, writer as never, context);
    await runTest({ script, sent, done });
    script.end();
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });

// A fixed settle can be too short on a loaded machine; the supersede tests
// wait for the run to have actually processed its turn instead.
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await settle();
  }
  assert.ok(condition(), 'condition never became true');
}

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const ack = (id: string, text: string, toolUseResult: Record<string, unknown>) => ({
  type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  tool_use_result: toolUseResult,
});
const taskStarted = (taskId: string, toolUseId: string, taskType: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: taskType,
});
const taskNotification = (taskId: string, toolUseId: string, status: string) => ({
  type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, status, summary: `Task ${taskId} ${status}`, output_file: '',
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'launched', duration_ms: 1, num_turns: 1 });

test('stopping the last outstanding task releases the held process', async () => {
  await withRun(async ({ script, sent, done }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();

    // The turn is over for the client, the process is held for the workflow.
    assert.ok(sent.some((message) => message.kind === 'complete'));
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => [entry.sessionId, entry.tasks.map((task) => task.taskId)]), [[SESSION_ID, ['wf1']]]);
    assert.equal(script.released(), false, 'stdin stays open while the workflow runs');

    // The user stops it. The CLI answers with a `stopped` notification and
    // pushes no follow-up turn, so nothing else would ever end the hold.
    assert.equal(await stopClaudeSDKTask(SESSION_ID, 'wf1'), true);
    assert.deepEqual(script.stopped, ['wf1']);
    script.emit(taskNotification('wf1', 'toolu_wf', 'stopped'));
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'the process is let go once nothing is outstanding');
    void done;
  });
});

/** Fails the test instead of hanging it when an abort never settles. */
async function abortWithin(ms: number): Promise<boolean> {
  return await Promise.race([
    abortClaudeSDKSession(SESSION_ID, { interruptTimeoutMs: 50 }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`abort did not settle within ${ms} ms`)), ms).unref();
    }),
  ]);
}

test('Stop ends a turn the CLI runs after its stdin was already released', async () => {
  // julca 2026-10-15: the runtime had let go of stdin, but the CLI stayed up
  // for a background agent and ran a follow-up turn when a shell settled. The
  // SDK drops control requests written to an ended stdin, so interrupt()
  // never settled and ten Stop clicks did nothing for eight minutes.
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(result());
    await waitFor(() => script.released());

    script.hangInterrupts();
    script.emit({ type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Following up.' }] } });
    await settle();

    assert.equal(await abortWithin(1_000), true);
    assert.equal(script.interrupts(), 0, 'a request on an ended stdin can never be answered, so none is sent');
    assert.equal(script.closed(), true, 'the process is ended instead');
    await settle();
    assert.equal(sent.some((message) => message.kind === 'error'), false, 'the killed process is the abort, not an error');
  });
});

test('Stop ends the process when the CLI does not answer interrupt()', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'count', run_in_background: true }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(result());
    await settle();
    assert.equal(script.released(), false, 'stdin is held for the agent');

    script.hangInterrupts();
    // Impatient clicks while the first Stop is still waiting share it.
    const [first, second] = await Promise.all([abortWithin(1_000), abortWithin(1_000)]);

    assert.deepEqual([first, second], [true, true]);
    assert.equal(script.interrupts(), 1);
    assert.equal(script.closed(), true);
    await settle();
    assert.equal(sent.some((message) => message.kind === 'error'), false);
  });
});

test('Stop that the CLI answers leaves the process to wind down on its own', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'count', run_in_background: true }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(result());
    await settle();

    assert.equal(await abortWithin(1_000), true);
    assert.equal(script.interrupts(), 1);
    assert.equal(script.closed(), false);
  });
});

test('a held process is mid-turn only while the CLI answers a settled task', async () => {
  // The CLI's registry file says `busy` for an SDK process's whole life, so
  // the running-sessions list asks the runtime instead. Waiting on an agent
  // must not read as a response: the client would queue every new message.
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'count', run_in_background: true }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    script.emit(result());
    await settle();
    assert.equal(isClaudeSDKSessionMidTurn(SESSION_ID), false, 'the turn is over; the process only waits on its agent');

    script.emit({ type: 'system', subtype: 'task_progress', session_id: NATIVE_ID, task_id: 'a1', description: 'Running sleep', usage: { total_tokens: 1200, tool_uses: 1, duration_ms: 20_000 } });
    await settle();
    assert.equal(isClaudeSDKSessionMidTurn(SESSION_ID), false, 'the agent working is not the session answering');

    // The agent settles and the CLI relays its result in a turn of its own.
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    script.emit({ type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'The agent is done.' }] } });
    await settle();
    assert.equal(isClaudeSDKSessionMidTurn(SESSION_ID), true);

    script.emit(result());
    await settle();
    assert.equal(isClaudeSDKSessionMidTurn(SESSION_ID), false);
  });
});

test('a task that reported completed keeps the hold for the turn that relays its result', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();

    // Completed, unlike stopped, is followed by a turn the CLI pushes to relay
    // the result; closing stdin at the notification would cut it short.
    script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    await settle();
    assert.equal(script.released(), false);

    script.emit(result());
    await settle();
    assert.equal(script.released(), true, 'the follow-up turn\'s result ends the hold');
  });
});

test('an agent that ran in the foreground and settled before the result does not hold the process', async () => {
  await withRun(async ({ script }) => {
    // An Agent call without `run_in_background` is scored as background by
    // the static rule, but the CLI ran it in the foreground: its task started
    // and settled before the turn ended. The task events know that.
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'Return the word FOUR', subagent_type: 'general-purpose' }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    script.emit(ack('toolu_agent', 'FOUR', { status: 'completed', agentId: 'a1' }));
    script.emit(result());
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'nothing is outstanding, so nothing to hold for');
  });
});

test('a new turn stops the tasks the held process still has going before letting it go', async () => {
  // Two runs on one session, each with its own scripted CLI: the first is
  // held for a background agent, the second is the user's next message.
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: Omit<ProviderRuntimeContext, 'createQuery'> = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: first.createQuery });
    await settle();
    first.script.emit(init());
    first.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    first.script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    first.script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    first.script.emit(result());
    await waitFor(() => sent.some((message) => message.kind === 'complete'));
    assert.equal(first.script.released(), false, 'the first process is held for its agent');

    // Closing stdin alone would leave the CLI waiting for the agent, so the
    // superseded process would live on next to the new one for as long as
    // the agent runs. The stop has to reach it before stdin ends, because the
    // SDK drops control requests written to an ended stdin.
    // fork: a plain next message is fed into the held process (agents keep
    // running); only an edit, which rewinds the conversation, needs a new one.
    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd, resumeFromScratch: true }, writer as never, { ...context, createQuery: second.createQuery });
    await settle();
    assert.deepEqual(first.script.stopped, ['a1'], 'the held process is told to stop its agent');
    assert.equal(first.script.released(), true, 'and is then let go');
    assert.deepEqual(second.script.stopped, [], 'the new process is untouched');

    first.script.emit(taskNotification('a1', 'toolu_agent', 'stopped'));
    first.script.end();
    await firstRun;
    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a held process is still let go when stopping its tasks throws', async () => {
  // Stopping is best effort; a stop that throws on the spot must not keep the
  // held process alive or take the new turn down with it.
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: Omit<ProviderRuntimeContext, 'createQuery'> = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
  const throwingStop: NonNullable<ProviderRuntimeContext['createQuery']> = (options) =>
    Object.assign(first.createQuery(options), {
      stopTask: () => { throw new Error('stop failed'); },
    });

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: throwingStop });
    await settle();
    first.script.emit(init());
    first.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    first.script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    first.script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    first.script.emit(result());
    await waitFor(() => sent.some((message) => message.kind === 'complete'));
    assert.equal(first.script.released(), false, 'the first process is held for its agent');

    // fork: a plain next message is fed into the held process (agents keep
    // running); only an edit, which rewinds the conversation, needs a new one.
    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd, resumeFromScratch: true }, writer as never, { ...context, createQuery: second.createQuery });
    await settle();
    assert.equal(first.script.released(), true, 'the held process is let go anyway');

    first.script.end();
    await firstRun;
    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    assert.equal(second.script.released(), true, 'the new turn ran to completion');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a turn whose tool emits no task events still holds on the static rule', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    script.emit(ack('toolu_monitor', 'Monitor started', {}));
    script.emit(result());
    await settle();

    assert.equal(script.released(), false, 'Monitor reports no task, so the launch rule decides');
  });
});

test('fork: the next message goes into the held process and its agents keep running', async () => {
  // interrupt() or stopTask() on a held process kills its background agents,
  // so a plain follow-up message must reach the live CLI instead.
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  let secondProcessStarted = false;
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: Omit<ProviderRuntimeContext, 'createQuery'> = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: first.createQuery });
    await settle();
    first.script.emit(init());
    first.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    first.script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    first.script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    first.script.emit(result());
    await waitFor(() => sent.some((message) => message.kind === 'complete'));

    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd }, writer as never, {
      ...context,
      createQuery: (options: Parameters<NonNullable<ProviderRuntimeContext['createQuery']>>[0]) => {
        secondProcessStarted = true;
        return first.createQuery(options);
      },
    });
    await settle();
    assert.deepEqual(first.script.stopped, [], 'the agent is not stopped');
    assert.equal(first.script.released(), false, 'the held process keeps its stdin');
    assert.equal(secondProcessStarted, false, 'no second CLI process');

    // The injected turn ends with its own result.
    first.script.emit(result());
    await secondRun;

    first.script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    first.script.emit(result());
    first.script.end();
    await firstRun;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

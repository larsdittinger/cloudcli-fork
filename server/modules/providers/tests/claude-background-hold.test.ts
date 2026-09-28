import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHeldPromptStream,
  startsBackgroundWork,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';

const toolUse = (name: string, input: Record<string, unknown> = {}) => ({
  message: { content: [{ type: 'tool_use', name, input }] },
});

test('a backgrounded subagent holds the process open', () => {
  // Missing `Agent` here let stdin close right after the turn, and the CLI's
  // wait ceiling then killed every subagent that ran longer than 30 minutes.
  assert.equal(startsBackgroundWork(toolUse('Agent', { run_in_background: true })), true);
  assert.equal(startsBackgroundWork(toolUse('Task', { run_in_background: true })), true);
  assert.equal(startsBackgroundWork(toolUse('Bash', { run_in_background: true })), true);
});

test('foreground tools do not hold the process open', () => {
  assert.equal(startsBackgroundWork(toolUse('Agent', { prompt: 'x' })), false);
  assert.equal(startsBackgroundWork(toolUse('Bash', { command: 'ls' })), false);
  assert.equal(startsBackgroundWork(toolUse('Read', { file_path: '/x' })), false);
});

test('the held prompt stream stays open and takes later turns until released', async () => {
  const held = createHeldPromptStream([{ n: 1 }]);
  const iterator = held.stream[Symbol.asyncIterator]();

  assert.deepEqual((await iterator.next()).value, { n: 1 });

  // Parked: nothing more until a later turn is pushed.
  const pending = iterator.next();
  const raced = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve('parked'), 20))]);
  assert.equal(raced, 'parked');

  assert.equal(held.push([{ n: 2 }]), true);
  assert.deepEqual((await pending).value, { n: 2 });

  held.release();
  assert.equal(held.isReleased(), true);
  assert.equal((await iterator.next()).done, true);
  assert.equal(held.push([{ n: 3 }]), false);
});

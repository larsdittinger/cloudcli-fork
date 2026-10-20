import assert from 'node:assert/strict';
import test from 'node:test';

import { runTokens } from '@/modules/isolation/run-tokens.js';

test('mint/resolve returns the run the token was issued for', () => {
  const token = runTokens.mint({
    projectId: 'p1',
    sessionId: 's1',
    purpose: 'claude',
    channel: { messageId: 'm1', threadKey: 't1', sender: 'a@b.cz' },
    taskId: 7,
  });
  const info = runTokens.resolve(token);
  assert.ok(info);
  assert.equal(info.projectId, 'p1');
  assert.equal(info.sessionId, 's1');
  assert.equal(info.purpose, 'claude');
  assert.deepEqual(info.channel, { messageId: 'm1', threadKey: 't1', sender: 'a@b.cz' });
  assert.equal(info.taskId, 7);
  runTokens.revoke(token);
});

test('token revoked on exit', () => {
  const token = runTokens.mint({ projectId: 'p1', sessionId: 's1', purpose: 'claude' });
  assert.ok(runTokens.resolve(token));
  runTokens.revoke(token); // what the runtime does when the sandbox process exits
  assert.equal(runTokens.resolve(token), null);
  runTokens.revoke(token); // idempotent
  assert.equal(runTokens.resolve(token), null);
});

test('unknown, empty and near-miss tokens resolve to null', () => {
  const token = runTokens.mint({ projectId: 'p1', sessionId: 's1', purpose: 'exec' });
  assert.equal(runTokens.resolve(''), null);
  assert.equal(runTokens.resolve('nope'), null);
  assert.equal(runTokens.resolve(`${token}x`), null);
  assert.equal(runTokens.resolve(token.slice(0, -1)), null);
  assert.equal(runTokens.resolve(undefined as unknown as string), null);
  runTokens.revoke(token);
});

test('tokens carry at least 32 bytes of randomness and never repeat', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const token = runTokens.mint({ projectId: 'p1', sessionId: `s${i}`, purpose: 'pty' });
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.ok(Buffer.from(token, 'base64url').length >= 32, `token too short: ${token}`);
    assert.ok(!seen.has(token));
    seen.add(token);
  }
  for (const token of seen) runTokens.revoke(token);
});

test('resolve returns a copy: callers cannot widen a run', () => {
  const token = runTokens.mint({ projectId: 'p1', sessionId: 's1', purpose: 'claude' });
  const info = runTokens.resolve(token)!;
  (info as { projectId: string }).projectId = 'other';
  assert.equal(runTokens.resolve(token)?.projectId, 'p1');
  runTokens.revoke(token);
});

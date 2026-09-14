import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchMessage, dispatchQueuedMessages } from '@/modules/channels/dispatcher.service.js';
import { createRuntime, makeMessage, withIsolatedDatabase } from '@/modules/channels/tests/helpers.js';
import type { RunCall } from '@/modules/channels/tests/helpers.js';
import type { RuleInput } from '@/modules/channels/types.js';
import { channelAccountsDb, channelMessagesDb, channelRulesDb, channelThreadsDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

function seed(ruleOverrides: Partial<RuleInput> = {}, projectPath = '/tmp/channels-project') {
  const account = channelAccountsDb.create({ type: 'email', label: 'Gmail', config: {}, secrets: {} });
  const rule = channelRulesDb.create({
    name: 'orders',
    conditions: { senders: ['@firma.cz'] },
    projectPath,
    provider: 'claude',
    permissionMode: 'bypassPermissions',
    replyMode: 'draft',
    ...ruleOverrides,
  });
  return { account, rule };
}

test('a message creates a chat in the rule project and runs the rendered prompt', async () => {
  await withIsolatedDatabase(async (dir) => {
    const { account, rule } = seed({}, dir);
    const row = channelMessagesDb.insert(makeMessage({ accountId: account.id, text: 'chci 3 kusy' }), 'unmatched')!;

    const runs: RunCall[] = [];
    const result = await dispatchMessage(row.id, rule.id, createRuntime(runs));

    assert.equal(result.started, true);
    assert.ok(result.sessionId);
    const session = sessionsDb.getSessionById(result.sessionId!);
    assert.equal(session?.project_path, dir);
    assert.ok(session?.custom_name?.startsWith('E-mail: Jan Novak'));
    assert.equal(runs.length, 1);
    assert.ok(runs[0].command.includes('chci 3 kusy'));
    assert.ok(runs[0].command.includes(row.id));
    assert.equal(runs[0].options.permissionMode, 'bypassPermissions');
    assert.equal(channelMessagesDb.get(row.id)?.status, 'dispatched');
    assert.equal(channelMessagesDb.get(row.id)?.session_id, result.sessionId);
  });
});

test('a second message in the same thread continues the same chat; conversation=new never does', async () => {
  await withIsolatedDatabase(async (dir) => {
    const { account, rule } = seed({}, dir);
    const first = channelMessagesDb.insert(makeMessage({ accountId: account.id, threadKey: 't-1' }), 'unmatched')!;
    const second = channelMessagesDb.insert(makeMessage({ accountId: account.id, threadKey: 't-1' }), 'unmatched')!;

    const runs: RunCall[] = [];
    const a = await dispatchMessage(first.id, rule.id, createRuntime(runs));
    const b = await dispatchMessage(second.id, rule.id, createRuntime(runs));
    assert.equal(a.sessionId, b.sessionId);

    const fresh = channelRulesDb.create({ name: 'fresh', conditions: {}, projectPath: dir, provider: 'claude', conversation: 'new' });
    const third = channelMessagesDb.insert(makeMessage({ accountId: account.id, threadKey: 't-1' }), 'unmatched')!;
    const fourth = channelMessagesDb.insert(makeMessage({ accountId: account.id, threadKey: 't-1' }), 'unmatched')!;
    const c = await dispatchMessage(third.id, fresh.id, createRuntime(runs));
    const d = await dispatchMessage(fourth.id, fresh.id, createRuntime(runs));
    assert.notEqual(c.sessionId, d.sessionId);
  });
});

test('a busy chat queues the message and the queue pass sends it once the run ends', async () => {
  await withIsolatedDatabase(async (dir) => {
    const { account, rule } = seed({}, dir);
    const first = channelMessagesDb.insert(makeMessage({ accountId: account.id, threadKey: 't-2' }), 'unmatched')!;
    const runs: RunCall[] = [];
    const a = await dispatchMessage(first.id, rule.id, createRuntime(runs));

    // Simulate a run in progress on that chat.
    chatRunRegistry.startRun({ appSessionId: a.sessionId!, provider: 'claude', providerSessionId: null, connection: null, userId: null });

    const second = channelMessagesDb.insert(makeMessage({ accountId: account.id, threadKey: 't-2' }), 'unmatched')!;
    const b = await dispatchMessage(second.id, rule.id, createRuntime(runs));
    assert.equal(b.started, false);
    assert.equal(channelMessagesDb.get(second.id)?.status, 'queued');
    assert.equal(runs.length, 1);

    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 0);

    chatRunRegistry.clearAll();
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.equal(channelMessagesDb.get(second.id)?.status, 'dispatched');
    assert.equal(runs.length, 2);
  });
});

test('a remembered chat that was deleted is replaced, and a crashing runtime marks the message failed', async () => {
  await withIsolatedDatabase(async (dir) => {
    const { account, rule } = seed({}, dir);
    channelThreadsDb.set(rule.id, 't-3', 'gone-session');
    const row = channelMessagesDb.insert(makeMessage({ accountId: account.id, threadKey: 't-3' }), 'unmatched')!;

    const runs: RunCall[] = [];
    const result = await dispatchMessage(row.id, rule.id, createRuntime(runs));
    assert.equal(result.started, true);
    assert.notEqual(result.sessionId, 'gone-session');
    assert.equal(channelThreadsDb.get(rule.id, 't-3'), result.sessionId);

    const failing = channelMessagesDb.insert(makeMessage({ accountId: account.id, threadKey: 't-4' }), 'unmatched')!;
    const failed = await dispatchMessage(failing.id, rule.id, createRuntime(runs, 'throw'));
    assert.equal(failed.started, false);
    assert.equal(channelMessagesDb.get(failing.id)?.status, 'failed');
    assert.ok(channelMessagesDb.get(failing.id)?.status_detail);
  });
});

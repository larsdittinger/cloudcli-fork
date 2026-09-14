import assert from 'node:assert/strict';
import test from 'node:test';

import {
  channelAccountsDb,
  channelMessagesDb,
  channelOutboxDb,
  channelRulesDb,
  channelThreadsDb,
} from '@/modules/database/index.js';
import { makeMessage, withIsolatedDatabase } from '@/modules/channels/tests/helpers.js';

test('accounts: create, update and status', async () => {
  await withIsolatedDatabase(() => {
    const account = channelAccountsDb.create({ type: 'email', label: 'Gmail', config: { host: 'imap.gmail.com' }, secrets: { password: 'x' } });
    assert.equal(account.status, 'disconnected');
    assert.equal(account.agent_send, 'off');

    const updated = channelAccountsDb.update(account.id, { label: 'Work', agentSend: 'draft', enabled: false });
    assert.equal(updated?.label, 'Work');
    assert.equal(updated?.agent_send, 'draft');
    assert.equal(updated?.enabled, 0);
    assert.equal(JSON.parse(updated!.secrets).password, 'x');

    channelAccountsDb.setStatus(account.id, 'connected');
    assert.equal(channelAccountsDb.get(account.id)?.status, 'connected');
    assert.ok(channelAccountsDb.get(account.id)?.last_seen_at);
  });
});

test('rules: positions and reorder', async () => {
  await withIsolatedDatabase(() => {
    const a = channelRulesDb.create({ name: 'A', conditions: {}, projectPath: '/p', provider: 'claude' });
    const b = channelRulesDb.create({ name: 'B', conditions: {}, projectPath: '/p', provider: 'claude' });
    const c = channelRulesDb.create({ name: 'C', conditions: {}, projectPath: '/p', provider: 'claude' });
    assert.deepEqual(channelRulesDb.listOrdered().map((rule) => rule.name), ['A', 'B', 'C']);

    channelRulesDb.reorder([c.id, a.id]);
    assert.deepEqual(channelRulesDb.listOrdered().map((rule) => rule.name), ['C', 'A', 'B']);

    const updated = channelRulesDb.update(b.id, { replyMode: 'draft', conditions: { senders: ['@firma.cz'] } });
    assert.equal(updated?.reply_mode, 'draft');
    assert.deepEqual(JSON.parse(updated!.conditions), { senders: ['@firma.cz'] });
    assert.equal(updated?.permission_mode, 'default');
  });
});

test('messages: duplicate external id is rejected, queue order and session lookup', async () => {
  await withIsolatedDatabase(() => {
    const first = channelMessagesDb.insert(makeMessage({ externalId: 'same', receivedAt: '2026-09-14T10:00:02.000Z' }), 'queued');
    assert.ok(first);
    const duplicate = channelMessagesDb.insert(makeMessage({ externalId: 'same' }), 'unmatched');
    assert.equal(duplicate, null);

    channelMessagesDb.insert(makeMessage({ receivedAt: '2026-09-14T10:00:01.000Z' }), 'queued');
    assert.deepEqual(
      channelMessagesDb.listQueued().map((row) => row.received_at),
      ['2026-09-14T10:00:01.000Z', '2026-09-14T10:00:02.000Z'],
    );

    channelMessagesDb.attachRule(first!.id, null, 'session-1');
    assert.equal(channelMessagesDb.getBySession('session-1')?.id, first!.id);
    assert.equal(channelMessagesDb.countByStatus().queued, 2);
  });
});

test('threads and outbox', async () => {
  await withIsolatedDatabase(() => {
    channelThreadsDb.set('rule', 'thread', 's1');
    channelThreadsDb.set('rule', 'thread', 's2');
    assert.equal(channelThreadsDb.get('rule', 'thread'), 's2');
    channelThreadsDb.deleteBySession('s2');
    assert.equal(channelThreadsDb.get('rule', 'thread'), null);

    const row = channelOutboxDb.create({ accountId: 'acc', to: 'jan@firma.cz', text: 'Ahoj', status: 'sending', createdBy: 'agent' });
    assert.equal(channelOutboxDb.failSending(), 1);
    assert.equal(channelOutboxDb.get(row.id)?.status, 'failed');

    channelOutboxDb.setStatus(row.id, 'sent', { externalId: 'ext-9', text: 'Ahoj!' });
    const sent = channelOutboxDb.get(row.id)!;
    assert.equal(sent.external_id, 'ext-9');
    assert.equal(sent.text, 'Ahoj!');
    assert.ok(sent.sent_at);
    assert.equal(channelOutboxDb.list({ status: ['sent'] }).length, 1);
  });
});

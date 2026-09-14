import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChannelAdapter, SendInput } from '@/modules/channels/adapters/channel-adapter.js';
import { channelsService } from '@/modules/channels/channels.service.js';
import { __setSleep, outboxService } from '@/modules/channels/outbox.service.js';
import { createRuntime, makeMessage, withIsolatedDatabase } from '@/modules/channels/tests/helpers.js';
import { appConfigDb, channelMessagesDb, channelRulesDb } from '@/modules/database/index.js';

type Sent = SendInput & { at: number };

function fakeAdapter(sent: Sent[], behaviour: { failFirst?: boolean } = {}): ChannelAdapter {
  let calls = 0;
  return {
    type: 'webhook',
    async start(_account, hooks) { hooks.onStatus('connected'); },
    async stop() {},
    async send(input) {
      calls += 1;
      if (behaviour.failFirst && calls === 1) throw new Error('smtp down');
      sent.push({ ...input, at: Date.now() });
      return { externalId: `sent-${calls}` };
    },
  };
}

async function setup(dir: string, replyMode: 'none' | 'draft' | 'auto', agentSend: 'off' | 'draft' | 'auto' = 'off', behaviour: { failFirst?: boolean } = {}) {
  const sent: Sent[] = [];
  channelsService.setRuntime(createRuntime([]));
  channelsService.registerAdapterFactory('webhook', () => fakeAdapter(sent, behaviour));
  appConfigDb.set('channels_enabled', 'true');
  const account = await channelsService.createAccount({ type: 'webhook', label: 'Hook', agentSend });
  const rule = channelRulesDb.create({ name: 'r', conditions: { senders: ['jan@firma.cz'] }, projectPath: dir, provider: 'claude', replyMode });
  const message = channelMessagesDb.insert(makeMessage({ accountId: account.id, subject: 'Objednavka', raw: { replyTo: 'reply@firma.cz' } }), 'dispatched')!;
  channelMessagesDb.attachRule(message.id, rule.id, 'session-1');
  return { sent, account, rule, message };
}

async function teardown() {
  await channelsService.stopAll();
  appConfigDb.set('channels_enabled', 'false');
}

test('reply mode none refuses, draft waits, auto sends with Re: and reply-to', async () => {
  await withIsolatedDatabase(async (dir) => {
    const none = await setup(dir, 'none');
    await assert.rejects(
      () => outboxService.createReply({ messageId: none.message.id, text: 'hi', createdBy: 'agent' }),
      (error: unknown) => (error as { code?: string }).code === 'REPLY_NOT_ALLOWED',
    );
    await teardown();

    const draft = await setup(dir, 'draft');
    const row = await outboxService.createReply({ messageId: draft.message.id, text: 'hi', createdBy: 'agent' });
    assert.equal(row.status, 'draft');
    assert.equal(row.session_id, 'session-1');
    assert.equal(draft.sent.length, 0);
    assert.equal(outboxService.countDrafts(), 1);
    const approved = await outboxService.approve(row.id, { text: 'hello there' });
    assert.equal(approved.status, 'sent');
    assert.equal(approved.text, 'hello there');
    assert.equal(approved.external_id, 'sent-1');
    assert.equal(draft.sent[0].to, 'reply@firma.cz');
    assert.equal(draft.sent[0].subject, 'Re: Objednavka');
    assert.equal(draft.sent[0].inReplyTo?.id, draft.message.id);
    await teardown();

    const auto = await setup(dir, 'auto');
    const autoRow = await outboxService.createReply({ messageId: auto.message.id, text: 'now', createdBy: 'agent' });
    assert.equal(autoRow.status, 'sent');
    assert.equal(auto.sent.length, 1);
    await teardown();
  });
});

test('free-form sends follow agentSend; users may always send; failures can be retried', async () => {
  await withIsolatedDatabase(async (dir) => {
    const off = await setup(dir, 'draft', 'off', { failFirst: true });
    await assert.rejects(
      () => outboxService.createSend({ accountId: off.account.id, to: 'x@y', text: 'hi', createdBy: 'agent' }),
      (error: unknown) => (error as { code?: string }).code === 'SEND_NOT_ALLOWED',
    );
    const userRow = await outboxService.createSend({ accountId: off.account.id, to: 'x@y', text: 'hi', createdBy: 'user' });
    assert.equal(userRow.status, 'failed');
    assert.equal(userRow.status_detail, 'smtp down');
    const retried = await outboxService.retry(userRow.id);
    assert.equal(retried.status, 'sent');
    await teardown();

    const drafting = await setup(dir, 'draft', 'draft');
    const agentRow = await outboxService.createSend({ accountId: drafting.account.id, to: 'x@y', text: 'hi', createdBy: 'agent' });
    assert.equal(agentRow.status, 'draft');
    const discarded = outboxService.discard(agentRow.id);
    assert.equal(discarded.status, 'discarded');
    await teardown();
  });
});

test('two automatic sends on one account are spaced by the minimum gap', async () => {
  await withIsolatedDatabase(async (dir) => {
    const waits: number[] = [];
    __setSleep(async (ms) => { waits.push(ms); });
    try {
      const auto = await setup(dir, 'auto', 'auto');
      await outboxService.createSend({ accountId: auto.account.id, to: 'a', text: '1', createdBy: 'agent' });
      await outboxService.createSend({ accountId: auto.account.id, to: 'b', text: '2', createdBy: 'agent' });
      assert.equal(auto.sent.length, 2);
      assert.equal(waits.length, 1);
      assert.ok(waits[0] > 1500 && waits[0] <= 2000);
      await teardown();
    } finally {
      __setSleep((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    }
  });
});

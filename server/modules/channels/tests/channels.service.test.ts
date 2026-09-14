import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createWebhookAdapter, normalizeWebhookPayload } from '@/modules/channels/adapters/webhook.adapter.js';
import { channelsService } from '@/modules/channels/channels.service.js';
import { createRuntime, makeMessage, withIsolatedDatabase } from '@/modules/channels/tests/helpers.js';
import type { RunCall } from '@/modules/channels/tests/helpers.js';
import { appConfigDb, channelAccountsDb, channelMessagesDb, channelRulesDb } from '@/modules/database/index.js';

function deps(dir: string) {
  return {
    attachmentsDir: (messageId: string) => path.join(dir, 'attachments', messageId),
    saveConfig: () => {},
    log: () => {},
  };
}

test('normalizeWebhookPayload validates and stores attachments', async () => {
  await withIsolatedDatabase((dir) => {
    assert.throws(() => normalizeWebhookPayload('acc', { from: 'x' }, deps(dir)), (error: unknown) => (error as { code?: string }).code === 'WEBHOOK_PAYLOAD_INVALID');
    assert.throws(() => normalizeWebhookPayload('acc', 'nope', deps(dir)), (error: unknown) => (error as { code?: string }).code === 'WEBHOOK_PAYLOAD_INVALID');

    const message = normalizeWebhookPayload('acc', {
      id: 'evt-1',
      from: '+420777123456',
      name: 'Jan',
      text: 'ahoj',
      thread: 'chat-9',
      attachments: [{ name: 'note.txt', mime: 'text/plain', contentBase64: Buffer.from('hello').toString('base64') }],
    }, deps(dir));
    assert.equal(message.channel, 'webhook');
    assert.equal(message.externalId, 'evt-1');
    assert.equal(message.threadKey, 'chat-9');
    assert.equal(message.from.name, 'Jan');
    assert.equal(message.attachments.length, 1);
    assert.equal(message.attachments[0].size, 5);
    assert.equal(fs.readFileSync(message.attachments[0].path, 'utf8'), 'hello');

    const hashed = normalizeWebhookPayload('acc', { from: 'a', text: 'b' }, deps(dir));
    assert.equal(hashed.externalId.length, 64);
    assert.equal(hashed.threadKey, hashed.externalId);
  });
});

test('ingest: duplicates are dropped, own messages ignored, rules dispatch, no rule leaves unmatched', async () => {
  await withIsolatedDatabase(async (dir) => {
    const runs: RunCall[] = [];
    channelsService.setRuntime(createRuntime(runs));
    const account = channelAccountsDb.create({ type: 'email', label: 'Gmail', config: { user: 'Me@Example.com' }, secrets: {} });
    channelRulesDb.create({ name: 'orders', conditions: { senders: ['@firma.cz'] }, projectPath: dir, provider: 'claude' });

    const first = await channelsService.ingest(account.id, makeMessage({ accountId: account.id, externalId: 'dup' }));
    assert.equal(first?.status, 'dispatched');
    assert.equal(runs.length, 1);

    const duplicate = await channelsService.ingest(account.id, makeMessage({ accountId: account.id, externalId: 'dup' }));
    assert.equal(duplicate, null);
    assert.equal(runs.length, 1);

    const self = await channelsService.ingest(account.id, makeMessage({ accountId: account.id, from: { address: 'me@example.com' } }));
    assert.equal(self?.status, 'ignored');
    const echoed = await channelsService.ingest(account.id, makeMessage({ accountId: account.id, raw: { fromMe: true } }));
    assert.equal(echoed?.status, 'ignored');

    const stranger = await channelsService.ingest(account.id, makeMessage({ accountId: account.id, from: { address: 'x@jina.cz' } }));
    assert.equal(stranger?.status, 'unmatched');
    assert.equal(runs.length, 1);
    assert.equal(channelMessagesDb.countByStatus().unmatched, 1);
  });
});

test('webhook end to end: token check, running adapter, dispatch', async () => {
  await withIsolatedDatabase(async (dir) => {
    const runs: RunCall[] = [];
    channelsService.setRuntime(createRuntime(runs));
    channelsService.registerAdapterFactory('webhook', createWebhookAdapter);
    appConfigDb.set('channels_enabled', 'true');

    const created = await channelsService.createAccount({ type: 'webhook', label: 'Hook' });
    const token = created.secretsOnce?.token;
    assert.ok(token && token.length >= 40);
    assert.equal(created.status, 'connected');
    assert.equal(channelsService.getAccount(created.id).hasSecrets, true);
    assert.equal(created.webhookUrlPath, `/api/channels/webhook/${created.id}`);

    channelRulesDb.create({ name: 'all', conditions: {}, projectPath: dir, provider: 'claude', replyMode: 'draft' });

    await assert.rejects(
      () => channelsService.ingestWebhook(created.id, 'wrong', { from: 'a', text: 'b' }),
      (error: unknown) => (error as { code?: string }).code === 'WEBHOOK_TOKEN_INVALID',
    );

    const stored = await channelsService.ingestWebhook(created.id, token!, { from: 'a', text: 'b', id: 'e1' });
    assert.equal(stored.status, 'dispatched');
    assert.ok(stored.session_id);
    assert.equal(runs.length, 1);

    await channelsService.stopAll();
    appConfigDb.set('channels_enabled', 'false');
  });
});

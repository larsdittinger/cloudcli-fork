import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { createWebhookAdapter } from '@/modules/channels/adapters/webhook.adapter.js';
import { channelsService } from '@/modules/channels/channels.service.js';
import { outboxService } from '@/modules/channels/outbox.service.js';
import { createRuntime, makeMessage, withIsolatedDatabase } from '@/modules/channels/tests/helpers.js';
import { appConfigDb, channelAccountsDb, channelMessagesDb, channelRulesDb } from '@/modules/database/index.js';

test('callback authenticates, distinguishes internal handoffs and retains the decision id on retry', async () => {
  await withIsolatedDatabase(async (dir) => {
    const received: Array<{ auth: string | undefined; body: Record<string, any> }> = [];
    const server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      received.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(received.length === 1 ? 503 : 200).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    channelsService.setRuntime(createRuntime([]));
    channelsService.registerAdapterFactory('webhook', createWebhookAdapter);
    appConfigDb.set('channels_enabled', 'true');
    try {
      const account = await channelsService.createAccount({
        type: 'webhook', label: 'Meta',
        config: { replyUrl: `http://127.0.0.1:${port}`, allowEscalation: true },
        secrets: { replyToken: 'callback-secret' },
      });
      assert.equal(account.config.replyToken, undefined);
      const rule = channelRulesDb.create({ name: 'r', conditions: { senders: ['meta-monitor'] }, projectPath: dir, provider: 'claude', replyMode: 'auto' });
      const message = channelMessagesDb.insert(makeMessage({ accountId: account.id, channel: 'webhook', externalId: 'mid.123', threadKey: 'meta:thread', from: { address: 'meta-monitor' }, raw: { metadata: { kind: 'comment', commentId: '123', pageId: '456' } } }), 'dispatched')!;
      channelMessagesDb.attachRule(message.id, rule.id, 'session-1');
      const row = await outboxService.createReply({ messageId: message.id, text: 'Refund exception: please review.', action: 'escalate', createdBy: 'agent' });
      assert.equal(row.status, 'failed');
      assert.equal(received[0].auth, 'Bearer callback-secret');
      assert.equal(received[0].body.action, 'escalate');
      assert.equal(received[0].body.id, row.id);
      assert.equal(received[0].body.inReplyTo.externalId, 'mid.123');
      assert.equal(received[0].body.inReplyTo.thread, 'meta:thread');
      assert.deepEqual(received[0].body.inReplyTo.metadata, { kind: 'comment', commentId: '123', pageId: '456' });
      const retried = await outboxService.retry(row.id);
      assert.equal(retried.status, 'sent');
      assert.equal(received[1].body.id, row.id);
      assert.equal(received[1].body.action, 'escalate');

      channelRulesDb.update(rule.id, { replyMode: 'none' });
      await assert.rejects(() => outboxService.createReply({ messageId: message.id, text: 'internal', action: 'escalate', createdBy: 'agent' }), { code: 'REPLY_NOT_ALLOWED' });
      channelAccountsDb.update(account.id, { config: {} });
      await assert.rejects(() => outboxService.createReply({ messageId: message.id, text: 'internal', action: 'escalate', createdBy: 'agent' }), { code: 'ESCALATION_NOT_ALLOWED' });
      const email = channelMessagesDb.insert(makeMessage({ accountId: account.id }), 'dispatched')!;
      await assert.rejects(() => outboxService.createReply({ messageId: email.id, text: 'internal', action: 'escalate', createdBy: 'agent' }), { code: 'REPLY_ACTION_INVALID' });
    } finally {
      await channelsService.stopAll();
      appConfigDb.set('channels_enabled', 'false');
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test('callbacks do not follow redirects with a secret', async () => {
  let destinationCalled = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/start') res.writeHead(307, { Location: '/destination' }).end();
    else { destinationCalled = true; res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await withIsolatedDatabase(async (dir) => {
    const account = channelAccountsDb.create({ type: 'webhook', label: 'Hook', config: { replyUrl: `http://127.0.0.1:${port}/start` }, secrets: { replyToken: 'secret' } });
    const adapter = createWebhookAdapter({ accountId: account.id, attachmentsDir: (id) => path.join(dir, id), saveConfig: () => {}, log: () => {} });
    try {
      await adapter.start(account, { onMessage: async () => {}, onStatus: () => {} });
      await assert.rejects(() => adapter.send({ to: 'customer', text: 'answer' }));
      assert.equal(destinationCalled, false);
    } finally {
      await adapter.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test('webhook configuration rejects invalid callback URLs and multiline tokens', async () => {
  await withIsolatedDatabase(async () => {
    for (const replyUrl of ['file:///etc/passwd', 'https://user:pass@example.com', 'not-a-url']) {
      await assert.rejects(() => channelsService.createAccount({ type: 'webhook', label: 'Hook', config: { replyUrl } }), { code: 'CHANNEL_CONFIG_INVALID' });
    }
    await assert.rejects(() => channelsService.createAccount({ type: 'webhook', label: 'Hook', secrets: { replyToken: 'bad\r\nheader' } }), { code: 'CHANNEL_SECRETS_INVALID' });
  });
});

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { createWebhookAdapter } from '@/modules/channels/adapters/webhook.adapter.js';
import channelsMcpRoutes from '@/modules/channels/channels-mcp.routes.js';
import { channelsService } from '@/modules/channels/channels.service.js';
import { createRuntime, makeMessage, withIsolatedDatabase } from '@/modules/channels/tests/helpers.js';
import { appConfigDb, channelMessagesDb, channelRulesDb } from '@/modules/database/index.js';

test('MCP endpoint: token gate, reply as draft, get and list', async () => {
  await withIsolatedDatabase(async (dir) => {
    channelsService.setRuntime(createRuntime([]));
    channelsService.registerAdapterFactory('webhook', createWebhookAdapter);
    appConfigDb.set('channels_enabled', 'true');
    const account = await channelsService.createAccount({ type: 'webhook', label: 'Hook' });
    const rule = channelRulesDb.create({ name: 'r', conditions: {}, projectPath: dir, provider: 'claude', replyMode: 'draft' });
    const message = channelMessagesDb.insert(makeMessage({ accountId: account.id, channel: 'webhook' }), 'dispatched')!;
    channelMessagesDb.attachRule(message.id, rule.id, 'session-9');

    const app = express();
    app.use(express.json());
    app.use('/api/channels-mcp', channelsMcpRoutes);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const token = channelsService.getMcpToken();

    const call = async (tool: string, body: unknown, auth = `Bearer ${token}`) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/channels-mcp/tools/${tool}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify(body),
      });
      return { status: response.status, json: (await response.json()) as { success: boolean; data?: any; error?: string } };
    };

    try {
      assert.equal((await call('channels_list_accounts', {}, 'Bearer nope')).status, 401);

      const reply = await call('channels_reply', { message_id: message.id, text: 'Diky!' });
      assert.equal(reply.status, 200);
      assert.equal(reply.json.data.status, 'draft');
      assert.equal(reply.json.data.deliveredNow, false);

      const missing = await call('channels_get_message', { message_id: 'nope' });
      assert.equal(missing.status, 404);

      const full = await call('channels_get_message', { message_id: message.id });
      assert.equal(full.json.data.from, 'jan@firma.cz');
      assert.equal(full.json.data.sessionId, 'session-9');

      const list = await call('channels_list_messages', { account_id: account.id, thread_key: message.thread_key });
      assert.equal(list.json.data.length, 1);

      const accounts = await call('channels_list_accounts', {});
      assert.equal(accounts.json.data[0].label, 'Hook');

      const forbidden = await call('channels_send_message', { account_id: account.id, to: 'x', text: 'y' });
      assert.equal(forbidden.status, 403);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await channelsService.stopAll();
      appConfigDb.set('channels_enabled', 'false');
    }
  });
});

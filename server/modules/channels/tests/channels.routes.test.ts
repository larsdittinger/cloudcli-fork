import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { createWebhookAdapter } from '@/modules/channels/adapters/webhook.adapter.js';
import channelsRoutes from '@/modules/channels/channels.routes.js';
import channelsWebhookRoutes from '@/modules/channels/channels-webhook.routes.js';
import { __setMcpRegistrar, channelsService } from '@/modules/channels/channels.service.js';
import { createRuntime, withIsolatedDatabase } from '@/modules/channels/tests/helpers.js';
import type { RunCall } from '@/modules/channels/tests/helpers.js';
import { appConfigDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

type Json = Record<string, any>;

async function withServer(runTest: (call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: Json }>) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use('/api/channels/webhook', channelsWebhookRoutes);
  // Admin auth is exercised by the real middleware elsewhere; here the user is a stand-in admin.
  app.use('/api/channels', (req, _res, next) => { (req as express.Request & { user?: unknown }).user = { id: 1, role: 'admin' }; next(); }, channelsRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: String(err) } });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Json };
  };

  try {
    await runTest(call);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('admin REST: accounts, rules validation, webhook ingest, inbox and outbox', async () => {
  await withIsolatedDatabase(async (dir) => {
    const runs: RunCall[] = [];
    channelsService.setRuntime(createRuntime(runs));
    channelsService.registerAdapterFactory('webhook', createWebhookAdapter);
    __setMcpRegistrar({ register: async () => [], unregister: async () => [] });

    await withServer(async (call) => {
      const enabled = await call('PUT', '/api/channels/settings', { enabled: true });
      assert.equal(enabled.status, 200);
      assert.equal(enabled.json.data.enabled, true);

      const created = await call('POST', '/api/channels/accounts', { type: 'webhook', label: 'Hook', agentSend: 'draft' });
      assert.equal(created.status, 201);
      const account = created.json.data;
      assert.ok(account.secretsOnce.token);
      assert.equal(account.hasSecrets, true);
      assert.equal(account.webhookUrlPath, `/api/channels/webhook/${account.id}`);

      const listed = await call('GET', '/api/channels/accounts');
      assert.equal(listed.json.data[0].secretsOnce, undefined);
      assert.equal(listed.json.data[0].status, 'connected');

      const badRule = await call('POST', '/api/channels/rules', { name: 'open', conditions: {}, projectPath: dir, provider: 'claude', permissionMode: 'bypassPermissions' });
      assert.equal(badRule.status, 400);
      assert.equal(badRule.json.error.code, 'RULE_OPEN_AUTONOMY');

      const rule = await call('POST', '/api/channels/rules', { name: 'all', conditions: {}, projectPath: dir, provider: 'claude', replyMode: 'draft' });
      assert.equal(rule.status, 201);
      assert.equal(rule.json.data.ownerUserId, 1);

      const unauthorized = await call('POST', `/api/channels/webhook/${account.id}`, { from: 'a', text: 'b' });
      assert.equal(unauthorized.status, 401);

      const accepted = await call('POST', `/api/channels/webhook/${account.id}`, { from: 'jan@firma.cz', text: 'ahoj', id: 'e1' }, { Authorization: `Bearer ${account.secretsOnce.token}` });
      assert.equal(accepted.status, 202);
      assert.equal(accepted.json.data.status, 'dispatched');
      assert.equal(runs.length, 1);

      const messages = await call('GET', '/api/channels/messages?status=dispatched');
      assert.equal(messages.json.data.length, 1);
      assert.equal(messages.json.data[0].ruleName, 'all');
      const messageId = messages.json.data[0].id;

      const bySession = await call('GET', `/api/channels/messages/by-session/${accepted.json.data.sessionId}`);
      assert.equal(bySession.json.data.message.id, messageId);
      assert.equal(bySession.json.data.rule.name, 'all');

      const tested = await call('POST', `/api/channels/rules/${rule.json.data.id}/test`);
      assert.equal(tested.json.data.matches[0].matched, true);

      const summary = await call('GET', '/api/channels/summary');
      assert.equal(summary.json.data.drafts, 0);

      const outbox = await call('GET', `/api/channels/outbox?sessionId=${accepted.json.data.sessionId}&status=draft,failed`);
      assert.deepEqual(outbox.json.data, []);

      const reordered = await call('PUT', '/api/channels/rules/order', { ids: [rule.json.data.id] });
      assert.equal(reordered.status, 200);

      const disabled = await call('PUT', '/api/channels/settings', { enabled: false });
      assert.equal(disabled.json.data.enabled, false);
      const afterDisable = await call('POST', `/api/channels/webhook/${account.id}`, { from: 'a', text: 'b' }, { Authorization: `Bearer ${account.secretsOnce.token}` });
      assert.equal(afterDisable.status, 503);
    });

    await channelsService.stopAll();
    appConfigDb.set('channels_enabled', 'false');
    __setMcpRegistrar(null);
  });
});

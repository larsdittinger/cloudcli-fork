import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { createWebhookAdapter } from '@/modules/channels/adapters/webhook.adapter.js';
import channelsMcpRoutes from '@/modules/channels/channels-mcp.routes.js';
import channelsRoutes from '@/modules/channels/channels.routes.js';
import { channelsService } from '@/modules/channels/channels.service.js';
import { createRuntime, withIsolatedDatabase } from '@/modules/channels/tests/helpers.js';
import { appConfigDb, channelAccountsDb, channelRulesDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

async function startApi() {
  const app = express();
  app.use(express.json());
  app.use('/api/channels-mcp', channelsMcpRoutes);
  app.use('/api/channels', channelsRoutes);
  // Same shape as the server's global error middleware.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err instanceof AppError ? err.statusCode : 500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const call = async (method: string, url: string, body?: unknown, token?: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as { data?: any; error?: unknown } };
  };
  return { call, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('autonomy: with the switch on, agent accounts and rules are approved and live right away', async () => {
  await withIsolatedDatabase(async (dir) => {
    channelsService.setRuntime(createRuntime([]));
    channelsService.registerAdapterFactory('webhook', createWebhookAdapter);
    appConfigDb.set('channels_enabled', 'true');
    const api = await startApi();
    try {
      const token = channelsService.getMcpToken();
      assert.equal((await api.call('GET', '/api/channels/settings')).json.data.agentsAutoApprove, false);
      assert.equal((await api.call('PUT', '/api/channels/settings', { agentsAutoApprove: 'yes' })).status, 400);
      const saved = await api.call('PUT', '/api/channels/settings', { agentsAutoApprove: true });
      assert.equal(saved.json.data.agentsAutoApprove, true);

      const account = await api.call('POST', '/api/channels-mcp/tools/channels_propose_account', { type: 'webhook', label: 'n8n', note: 'for n8n', cwd: dir }, token);
      assert.equal(account.status, 200);
      const accountRow = channelAccountsDb.get(account.json.data.account.id);
      assert.equal(accountRow?.proposal, null);
      assert.equal(accountRow?.enabled, 1);
      assert.match(account.json.data.note, /without approval/i);

      const rule = await api.call('POST', '/api/channels-mcp/tools/channels_propose_rule', {
        name: 'n8n', account_id: accountRow?.id, note: 'route n8n', cwd: dir,
        conditions: { senders: ['bot@n8n.example'] }, reply_mode: 'draft',
      }, token);
      assert.equal(rule.status, 200, JSON.stringify(rule.json));
      const ruleRow = channelRulesDb.get(rule.json.data.rule.id);
      assert.equal(ruleRow?.proposal, null);
      assert.equal(ruleRow?.enabled, 1);

      const info = await api.call('POST', '/api/channels-mcp/tools/channels_get_info', { cwd: dir }, token);
      assert.equal(info.json.data.state.agentsAutoApprove, true);
    } finally {
      await api.close();
    }
  });
});

test('autonomy: the switch never lets an unsafe rule through', async () => {
  await withIsolatedDatabase(async (dir) => {
    channelsService.setRuntime(createRuntime([]));
    appConfigDb.set('channels_enabled', 'true');
    appConfigDb.set('channels_agents_auto_approve', 'true');
    const api = await startApi();
    try {
      const token = channelsService.getMcpToken();
      const unsafe = await api.call('POST', '/api/channels-mcp/tools/channels_propose_rule', {
        name: 'anyone', note: 'x', cwd: dir, reply_mode: 'auto', conditions: {},
      }, token);
      assert.equal(unsafe.status, 400);
    } finally {
      await api.close();
    }
  });
});

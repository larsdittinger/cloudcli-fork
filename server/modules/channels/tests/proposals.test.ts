import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { createWebhookAdapter } from '@/modules/channels/adapters/webhook.adapter.js';
import channelsMcpRoutes from '@/modules/channels/channels-mcp.routes.js';
import { channelsService } from '@/modules/channels/channels.service.js';
import { proposalsService } from '@/modules/channels/proposals.service.js';
import { createRuntime, makeMessage, withIsolatedDatabase } from '@/modules/channels/tests/helpers.js';
import { appConfigDb, channelAccountsDb, channelMessagesDb, channelRulesDb } from '@/modules/database/index.js';

async function startMcpApi() {
  const app = express();
  app.use(express.json());
  app.use('/api/channels-mcp', channelsMcpRoutes);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const token = channelsService.getMcpToken();
  const call = async (tool: string, body: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/channels-mcp/tools/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as { success: boolean; data?: any; error?: string } };
  };
  return { call, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('proposals: agent-created account and rule stay disabled until approved; approved config is off limits', async () => {
  await withIsolatedDatabase(async (dir) => {
    process.env.CLOUDCLI_PUBLIC_URL = 'https://cloudcli.example.cz/';
    channelsService.setRuntime(createRuntime([]));
    channelsService.registerAdapterFactory('webhook', createWebhookAdapter);
    appConfigDb.set('channels_enabled', 'true');
    const api = await startMcpApi();

    try {
      const info = await api.call('channels_get_info', { cwd: dir });
      assert.equal(info.status, 200);
      assert.match(info.json.data.guide, /channels_propose_rule/);
      assert.equal(info.json.data.state.publicUrl, 'https://cloudcli.example.cz');
      assert.equal(info.json.data.state.yourWorkingDirectory, dir);

      const proposed = await api.call('channels_propose_account', { type: 'webhook', label: 'n8n', note: 'Objednávky z n8n.', cwd: dir });
      assert.equal(proposed.status, 200);
      const accountId = proposed.json.data.account.id as string;
      assert.equal(proposed.json.data.account.enabled, false);
      assert.equal(proposed.json.data.account.proposal.note, 'Objednávky z n8n.');
      assert.equal(proposed.json.data.webhookUrl, `https://cloudcli.example.cz/api/channels/webhook/${accountId}`);
      assert.ok(proposed.json.data.webhookToken);
      // Pending webhook refuses traffic even with the right token.
      await assert.rejects(channelsService.ingestWebhook(accountId, proposed.json.data.webhookToken, { from: 'n8n', text: 'x' }), /disabled/);

      // An open rule may not run autonomously — proposals get the same validation as the UI.
      const open = await api.call('channels_propose_rule', { name: 'all', note: 'x', account_id: accountId, permission_mode: 'bypassPermissions', cwd: dir });
      assert.equal(open.status, 400);

      const rule = await api.call('channels_propose_rule', { name: 'n8n → projekt', note: 'Zpracuje objednávky.', account_id: accountId, conditions: { senders: ['n8n'] }, reply_mode: 'draft', cwd: dir });
      assert.equal(rule.status, 200);
      const ruleId = rule.json.data.rule.id as string;
      assert.equal(rule.json.data.rule.enabled, false);
      assert.equal(rule.json.data.rule.projectPath, dir, 'project defaults to the agent cwd');

      const approvedRule = channelRulesDb.create({ name: 'mine', conditions: {}, projectPath: dir, provider: 'claude' });
      const forbidden = await api.call('channels_withdraw_proposal', { kind: 'rule', id: approvedRule.id });
      assert.equal(forbidden.status, 403);
      assert.ok(channelRulesDb.get(approvedRule.id));
      channelRulesDb.delete(approvedRule.id);

      // Approval enables both and the webhook starts taking messages that reach the proposed rule.
      await channelsService.approveAccount(accountId);
      proposalsService.approveRule(ruleId);
      assert.equal(channelAccountsDb.get(accountId)?.enabled, 1);
      assert.equal(channelAccountsDb.get(accountId)?.proposal, null);
      assert.equal(channelRulesDb.get(ruleId)?.enabled, 1);
      const stored = await channelsService.ingestWebhook(accountId, proposed.json.data.webhookToken, { from: 'n8n', text: 'Nová objednávka' });
      assert.equal(stored.rule_id, ruleId);

      const late = await api.call('channels_withdraw_proposal', { kind: 'account', id: accountId });
      assert.equal(late.status, 403, 'approved account cannot be withdrawn');
    } finally {
      delete process.env.CLOUDCLI_PUBLIC_URL;
      await channelsService.stopAll();
      await api.close();
    }
  });
});

test('proposals: withdraw removes a pending proposal', async () => {
  await withIsolatedDatabase(async (dir) => {
    const api = await startMcpApi();
    try {
      const rule = await api.call('channels_propose_rule', { name: 'r', note: 'n', channel: 'email', conditions: { senders: ['@firma.cz'] }, cwd: dir });
      const id = rule.json.data.rule.id as string;
      const withdrawn = await api.call('channels_withdraw_proposal', { kind: 'rule', id });
      assert.equal(withdrawn.status, 200);
      assert.equal(channelRulesDb.get(id), null);
    } finally {
      await api.close();
    }
  });
});

test('build_link: message → its chat, otherwise a new chat in the project', async () => {
  await withIsolatedDatabase(async (dir) => {
    appConfigDb.set('channels_public_url', 'https://cloudcli.diti.cz');
    const api = await startMcpApi();
    try {
      const rule = channelRulesDb.create({ name: 'r', conditions: {}, projectPath: dir, provider: 'claude' });
      const message = channelMessagesDb.insert(makeMessage({ accountId: 'acc-1' }), 'dispatched')!;
      channelMessagesDb.attachRule(message.id, rule.id, 'session-42');

      const toChat = await api.call('channels_build_link', { prompt: 'Podívej se na tento e-mail', message_id: message.id, cwd: dir });
      assert.equal(toChat.status, 200);
      const chatUrl = new URL(toChat.json.data.url);
      assert.equal(chatUrl.origin, 'https://cloudcli.diti.cz');
      assert.equal(chatUrl.pathname, '/session/session-42');
      assert.equal(chatUrl.searchParams.get('prompt'), 'Podívej se na tento e-mail');
      assert.equal(chatUrl.searchParams.get('project'), null);

      const toProject = await api.call('channels_build_link', { prompt: 'Shrň dnešní poptávky', cwd: dir });
      const projectUrl = new URL(toProject.json.data.url);
      assert.equal(projectUrl.pathname, '/');
      assert.equal(projectUrl.searchParams.get('project'), dir);
      assert.equal(projectUrl.searchParams.get('prompt'), 'Shrň dnešní poptávky');

      const tooLong = await api.call('channels_build_link', { prompt: 'x'.repeat(4001), cwd: dir });
      assert.equal(tooLong.status, 400);
    } finally {
      await api.close();
    }
  });
});

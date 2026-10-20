import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { channelsMcpRoutes, channelsSandboxMcpRoutes, channelsService } from '@/modules/channels/index.js';
import { appConfigDb, channelAccountsDb, channelMessagesDb, channelRulesDb, projectsDb, tasksDb } from '@/modules/database/index.js';
import type { TaskRow } from '@/modules/database/index.js';
import { isolationDb } from '@/modules/isolation/isolation.db.js';
import { runTokens, type RunTokenInput } from '@/modules/isolation/run-tokens.js';
import { createSandboxApiApp, registerSandboxMcpRouter } from '@/modules/isolation/sandbox-api.server.js';
import { isolationEnvFor, withIsolatedDatabase, withIsolationEnv } from '@/modules/isolation/tests/helpers.js';
import { tasksMcpRoutes, tasksSandboxMcpRoutes } from '@/modules/tasks/index.js';

const DENIED = 'Not available to isolated agents.';
const TASKS_GLOBAL_TOKEN = 'global-tasks-token';

type Reply = { status: number; json: { success: boolean; data?: any; error?: string } };

function makeIsolated(dir: string, name: string, uid: number) {
  const projectPath = path.join(dir, 'isolated', name);
  fs.mkdirSync(projectPath, { recursive: true });
  const { project } = projectsDb.createProjectPath(projectPath, name);
  return isolationDb.markIsolated(project!.project_id, uid);
}

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

type Harness = {
  dir: string;
  a: ReturnType<typeof makeIsolated>;
  b: ReturnType<typeof makeIsolated>;
  /** A call on main.sock (here: the same app on TCP). */
  sandbox: (kind: 'channels' | 'tasks', tool: string, body: unknown, token: string) => Promise<Reply>;
  /** A call on the public mount (the app's own port). */
  pub: (kind: 'channels' | 'tasks', tool: string, body: unknown, token: string) => Promise<Reply>;
  mint: (input: Partial<RunTokenInput>) => string;
};

async function withHarness(run: (h: Harness) => Promise<void>) {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      const a = makeIsolated(dir, 'a', 20001);
      const b = makeIsolated(dir, 'b', 20002);
      appConfigDb.set('tasks_mcp_token', TASKS_GLOBAL_TOKEN);
      registerSandboxMcpRouter('channels', channelsSandboxMcpRoutes);
      registerSandboxMcpRouter('tasks', tasksSandboxMcpRoutes);

      const sandboxServer = await listen(createSandboxApiApp({ claudeProxy: (_req, res) => res.status(418).end() }));
      const publicApp = express();
      publicApp.use(express.json());
      publicApp.use('/api/channels-mcp', channelsMcpRoutes);
      publicApp.use('/api/tasks-mcp', tasksMcpRoutes);
      const publicServer = await listen(publicApp);

      const call = (base: string) => async (kind: 'channels' | 'tasks', tool: string, body: unknown, token: string): Promise<Reply> => {
        const response = await fetch(`${base}/api/${kind}-mcp/tools/${tool}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        return { status: response.status, json: (await response.json()) as Reply['json'] };
      };
      const minted: string[] = [];
      const mint = (input: Partial<RunTokenInput>) => {
        const token = runTokens.mint({ projectId: a.projectId, sessionId: 'sess-a', purpose: 'claude', ...input });
        minted.push(token);
        return token;
      };
      try {
        await run({ dir, a, b, sandbox: call(sandboxServer.base), pub: call(publicServer.base), mint });
      } finally {
        for (const token of minted) runTokens.revoke(token);
        await sandboxServer.close();
        await publicServer.close();
        await channelsService.stopAll();
      }
    });
  });
}

async function seedMessages(h: Harness) {
  const account = channelAccountsDb.create({ type: 'webhook', label: 'Hook', config: {}, secrets: { token: 'webhook-secret' } });
  const ruleA = channelRulesDb.create({ name: 'support a', accountId: account.id, conditions: {}, projectPath: h.a.projectPath, provider: 'claude', replyMode: 'draft' });
  const ruleB = channelRulesDb.create({ name: 'support b', conditions: {}, projectPath: h.b.projectPath, provider: 'claude', replyMode: 'draft' });
  const insert = (thread: string, from: string) => channelMessagesDb.insert({
    id: `msg-${thread}-${Math.random().toString(16).slice(2)}`,
    accountId: account.id,
    channel: 'webhook',
    externalId: `ext-${thread}-${Math.random()}`,
    threadKey: thread,
    from: { address: from, name: from },
    to: [],
    subject: `About ${thread}`,
    text: `Hello from ${from}`,
    isGroup: false,
    attachments: [],
    receivedAt: new Date().toISOString(),
    raw: {},
  }, 'dispatched')!;
  const own = insert('t-own', 'own@customer.cz');
  const other = insert('t-other', 'other@customer.cz');
  channelMessagesDb.attachRule(own.id, ruleA.id, 'sess-a');
  channelMessagesDb.attachRule(other.id, ruleA.id, 'sess-other');
  return { account, own, other, ruleA, ruleB };
}

function makeTask(projectPath: string, title: string): TaskRow {
  return tasksDb.create({
    title,
    brief: 'b',
    mandate: '',
    mandate_confirmed: 1,
    status: 'working',
    project_path: projectPath,
    provider: 'claude',
    model: null,
    effort: null,
    permission_mode: 'bypassPermissions',
    owner_user_id: null,
    created_by: 'owner',
    next_check_at: null,
    question: null,
  });
}

test('channels_get_message other thread denied', async () => {
  await withHarness(async (h) => {
    const { own, other } = await seedMessages(h);
    const token = h.mint({ channel: { messageId: own.id, threadKey: own.thread_key, sender: 'own@customer.cz' } });

    const mine = await h.sandbox('channels', 'channels_get_message', { message_id: own.id }, token);
    assert.equal(mine.status, 200);
    assert.equal(mine.json.data.from, 'own@customer.cz');

    const foreign = await h.sandbox('channels', 'channels_get_message', { message_id: other.id }, token);
    assert.equal(foreign.status, 403);
    assert.equal(foreign.json.error, DENIED);

    // Listing returns this session's messages only, whatever filter the agent asks for.
    const listed = await h.sandbox('channels', 'channels_list_messages', { limit: 100 }, token);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.data.map((row: { id: string }) => row.id), [own.id]);
    const byThread = await h.sandbox('channels', 'channels_list_messages', { account_id: other.account_id, thread_key: other.thread_key }, token);
    assert.deepEqual(byThread.json.data.map((row: { id: string }) => row.id), [own.id]);

    // A token of another session sees neither.
    const stranger = h.mint({ sessionId: 'sess-nobody' });
    assert.equal((await h.sandbox('channels', 'channels_get_message', { message_id: own.id }, stranger)).status, 403);
    // A session id the token does not carry never matches messages without one.
    const blank = h.mint({ sessionId: '' });
    assert.deepEqual((await h.sandbox('channels', 'channels_list_messages', {}, blank)).json.data, []);
  });
});

test('channels_reply own message ok', async () => {
  await withHarness(async (h) => {
    const { own, other } = await seedMessages(h);
    const token = h.mint({});

    const reply = await h.sandbox('channels', 'channels_reply', { message_id: own.id, text: 'Thanks!' }, token);
    assert.equal(reply.status, 200);
    assert.equal(reply.json.data.status, 'draft');

    const foreign = await h.sandbox('channels', 'channels_reply', { message_id: other.id, text: 'Hi' }, token);
    assert.equal(foreign.status, 403);
    assert.equal(foreign.json.error, DENIED);

    // A revoked token is gone for good.
    runTokens.revoke(token);
    assert.equal((await h.sandbox('channels', 'channels_reply', { message_id: own.id, text: 'Again' }, token)).status, 401);
  });
});

test('channels_propose_rule denied for run token', async () => {
  await withHarness(async (h) => {
    const { account, own } = await seedMessages(h);
    const token = h.mint({});
    const denied: Array<[string, Record<string, unknown>]> = [
      ['channels_propose_rule', { name: 'x', project_path: h.a.projectPath, permission_mode: 'bypassPermissions' }],
      ['channels_propose_account', { type: 'webhook', label: 'x' }],
      ['channels_send_message', { account_id: account.id, to: 'x@y.cz', text: 'hi' }],
      ['channels_build_link', { prompt: 'x', message_id: own.id }],
      ['channels_list_accounts', {}],
      ['channels_withdraw_proposal', { kind: 'rule', id: 'x' }],
      ['channels_whatsapp_pairing_code', { account_id: account.id }],
      ['channels_unknown', {}],
    ];
    for (const [tool, body] of denied) {
      const response = await h.sandbox('channels', tool, body, token);
      assert.equal(response.status, 403, tool);
      assert.equal(response.json.error, DENIED, tool);
    }
    assert.equal(channelRulesDb.listOrdered().filter((rule) => rule.name === 'x').length, 0);
  });
});

test('channels_get_info shows a reduced view: no secrets, no other projects', async () => {
  await withHarness(async (h) => {
    const { account } = await seedMessages(h);
    channelAccountsDb.create({ type: 'email', label: 'Unused <ceo@ethia.cz>', config: {}, secrets: {} });
    const token = h.mint({});
    const info = await h.sandbox('channels', 'channels_get_info', { cwd: h.b.projectPath }, token);
    assert.equal(info.status, 200);
    const { state } = info.json.data;
    const text = JSON.stringify(info.json.data);
    assert.equal(state.yourWorkingDirectory, h.a.projectPath);
    // Rules: only this project's, and only what the agent needs to know about its own run.
    assert.deepEqual(state.rules, [{ name: 'support a', replyMode: 'draft', permissionMode: 'default', conversation: 'thread' }]);
    // Accounts: only those this project's rules use.
    assert.deepEqual(state.accounts, [{ id: account.id, type: 'webhook', label: 'Hook' }]);
    assert.ok(!text.includes('Unused'), 'an account no rule of this project uses leaked');
    assert.ok(!text.includes(h.b.projectPath), 'another project leaked');
    assert.ok(!/webhookUrl|hasSecrets|token/i.test(JSON.stringify(state)), 'account details leaked');
  });
});

test('body cwd ignored', async () => {
  await withHarness(async (h) => {
    const taskA = makeTask(h.a.projectPath, 'A task');
    const taskB = makeTask(h.b.projectPath, 'B task');
    const token = h.mint({ taskId: taskA.id });

    // The token's project counts, not the cwd the agent sends: B's cwd does not make A's task foreign...
    const logged = await h.sandbox('tasks', 'tasks_log', { id: taskA.id, text: 'progress', cwd: h.b.projectPath }, token);
    assert.equal(logged.status, 200);
    // ...nor B's task its own.
    const foreign = await h.sandbox('tasks', 'tasks_log', { id: taskB.id, text: 'hijack', cwd: h.b.projectPath }, token);
    assert.equal(foreign.status, 403);

    makeTask(h.a.projectPath, 'A sibling');
    const used = channelAccountsDb.create({ type: 'email', label: 'Podpora', config: {}, secrets: {}, agentSend: 'draft' });
    channelAccountsDb.create({ type: 'email', label: 'CEO', config: {}, secrets: {} });
    channelRulesDb.create({ name: 'a', accountId: used.id, conditions: {}, projectPath: h.a.projectPath, provider: 'claude' });
    const info = await h.sandbox('tasks', 'tasks_get_info', { cwd: h.b.projectPath }, token);
    assert.equal(info.json.data.state.yourWorkingDirectory, h.a.projectPath);
    assert.deepEqual(info.json.data.state.openTasks.map((task: { id: number }) => task.id), [taskA.id]);
    assert.deepEqual(info.json.data.state.channelAccounts, [{ id: used.id, type: 'email', label: 'Podpora' }]);

    const created = await h.sandbox('tasks', 'tasks_create', {
      title: 'Follow up', brief: 'Ask again', cwd: h.b.projectPath, project_path: h.b.projectPath,
    }, token);
    assert.equal(created.status, 200);
    assert.equal(tasksDb.get(created.json.data.task.id)!.project_path, h.a.projectPath);
  });
});

test('global token rejected on main.sock', async () => {
  await withHarness(async (h) => {
    const { own } = await seedMessages(h);
    const channelsGlobal = channelsService.getMcpToken();
    const onSock = await h.sandbox('channels', 'channels_get_message', { message_id: own.id }, channelsGlobal);
    assert.equal(onSock.status, 401);
    assert.equal((await h.sandbox('tasks', 'tasks_get_info', {}, TASKS_GLOBAL_TOKEN)).status, 401);

    // The public mount stays as it is: the global token works, a run token does not.
    assert.equal((await h.pub('channels', 'channels_get_message', { message_id: own.id }, channelsGlobal)).status, 200);
    const token = h.mint({});
    assert.equal((await h.pub('channels', 'channels_get_message', { message_id: own.id }, token)).status, 401);
    assert.equal((await h.pub('tasks', 'tasks_get_info', {}, token)).status, 401);
    assert.equal((await h.pub('tasks', 'tasks_get_info', {}, TASKS_GLOBAL_TOKEN)).status, 200);
  });
});

test('only agent run tokens of a still isolated project with the tool switched on pass', async () => {
  await withHarness(async (h) => {
    const { own } = await seedMessages(h);
    for (const purpose of ['exec', 'pty', 'self-check'] as const) {
      const token = h.mint({ purpose });
      const response = await h.sandbox('channels', 'channels_get_message', { message_id: own.id }, token);
      assert.equal(response.status, 403, purpose);
      assert.equal(response.json.error, DENIED);
    }
    isolationDb.updateSettings(h.a.projectId, { tools: { channels: false, tasks: true } });
    const token = h.mint({});
    assert.equal((await h.sandbox('channels', 'channels_get_message', { message_id: own.id }, token)).status, 403);
    assert.equal((await h.sandbox('tasks', 'tasks_get_info', {}, token)).status, 200);
    const unknown = h.mint({ projectId: 'no-such-project' });
    assert.equal((await h.sandbox('tasks', 'tasks_get_info', {}, unknown)).status, 403);
  });
});

test('tasks other task denied', async () => {
  await withHarness(async (h) => {
    const mine = makeTask(h.a.projectPath, 'mine');
    const sibling = makeTask(h.a.projectPath, 'sibling in the same project');
    const token = h.mint({ taskId: mine.id });

    for (const [tool, body] of [
      ['tasks_update', { id: sibling.id, summary: 'x' }],
      ['tasks_log', { id: sibling.id, text: 'x' }],
      ['tasks_ask_owner', { id: sibling.id, question: 'x?' }],
      ['tasks_send_message', { task_id: sibling.id, text: 'x' }],
      ['tasks_get', { id: sibling.id }],
      ['tasks_list', {}],
    ] as Array<[string, Record<string, unknown>]>) {
      const response = await h.sandbox('tasks', tool, body, token);
      assert.equal(response.status, 403, tool);
      assert.equal(response.json.error, DENIED, tool);
    }

    assert.equal((await h.sandbox('tasks', 'tasks_update', { id: mine.id, summary: 'going well' }, token)).status, 200);
    assert.equal(tasksDb.get(mine.id)!.summary, 'going well');
    assert.equal((await h.sandbox('tasks', 'tasks_get', { id: mine.id }, token)).status, 200);

    // Sending out stays bound to the task's own run: running in another session is not this run.
    tasksDb.setRunning(mine.id, 'sess-other', new Date().toISOString());
    const send = await h.sandbox('tasks', 'tasks_send_message', { task_id: mine.id, text: 'hello' }, token);
    assert.equal(send.status, 409);

    // Without a task on the token only the info and a proposal are open.
    const plain = h.mint({});
    assert.equal((await h.sandbox('tasks', 'tasks_log', { id: mine.id, text: 'x' }, plain)).status, 403);
    assert.equal((await h.sandbox('tasks', 'tasks_get', { id: mine.id }, plain)).status, 403);
    // ...and the info lists no tasks: a prompt-injected agent could paste their summaries into a reply.
    const info = await h.sandbox('tasks', 'tasks_get_info', {}, plain);
    assert.equal(info.status, 200);
    assert.deepEqual(info.json.data.state.openTasks, []);
  });
});

test('tasks_create from isolated → proposal in same project without trusted mandate even with trust switch on', async () => {
  await withHarness(async (h) => {
    appConfigDb.set('tasks_trust_agent_mandates', 'true');
    const token = h.mint({});
    const created = await h.sandbox('tasks', 'tasks_create', {
      title: 'Ask the supplier', brief: 'Get a quote', mandate: 'Send anything', project_path: h.b.projectPath,
    }, token);
    assert.equal(created.status, 200);
    const row = tasksDb.get(created.json.data.task.id)!;
    assert.equal(row.project_path, h.a.projectPath);
    assert.equal(row.mandate_confirmed, 0);
    assert.equal(row.status, 'waiting_owner');
    assert.equal(row.next_check_at, null);
    assert.equal(JSON.parse(row.question!).by, 'system');
    assert.match(created.json.data.note, /proposal/i);

    // Defence in depth: an agent outside the sandbox creating a task for an isolated project gets no trust either.
    const viaGlobal = await h.pub('tasks', 'tasks_create', {
      title: 'Elsewhere', brief: 'x', project_path: h.b.projectPath, start_in_minutes: 60,
    }, TASKS_GLOBAL_TOKEN);
    assert.equal(viaGlobal.status, 200);
    assert.equal(tasksDb.get(viaGlobal.json.data.task.id)!.mandate_confirmed, 0);
  });
});

test('tasks_send_message from an isolated run only through the project\'s own accounts', async () => {
  await withHarness(async (h) => {
    const { account: own, other } = await seedMessages(h);
    // The owner's private account: auto-send, but no rule of the isolated project uses it.
    const foreign = channelAccountsDb.create({ type: 'email', label: 'Lars', config: {}, secrets: {}, agentSend: 'auto' });
    const task = makeTask(h.a.projectPath, 'answer the customer');
    tasksDb.setRunning(task.id, 'sess-a', new Date().toISOString());
    const token = h.mint({ taskId: task.id });

    const viaForeign = await h.sandbox('tasks', 'tasks_send_message', { task_id: task.id, account_id: foreign.id, to: 'boss@example.com', subject: 's', text: 'leak' }, token);
    assert.equal(viaForeign.status, 403);
    assert.equal(viaForeign.json.error, DENIED);

    // A reply picks the replied message's account: one of a foreign account is refused as well.
    const foreignMessage = channelMessagesDb.insert({
      id: `msg-foreign-${Math.random().toString(16).slice(2)}`, accountId: foreign.id, channel: 'email', externalId: 'ext-foreign',
      threadKey: 't-foreign', from: { address: 'friend@example.com', name: 'Friend' }, to: [], subject: 'Private', text: 'hi',
      isGroup: false, attachments: [], receivedAt: new Date().toISOString(), raw: {},
    }, 'unmatched')!;
    const replyForeign = await h.sandbox('tasks', 'tasks_send_message', { task_id: task.id, account_id: own.id, reply_to_message_id: foreignMessage.id, text: 'leak' }, token);
    assert.equal(replyForeign.status, 403);
    assert.equal(replyForeign.json.error, DENIED);

    // The project's own account passes this check; the normal send path decides the rest (here: agentSend off).
    const viaOwn = await h.sandbox('tasks', 'tasks_send_message', { task_id: task.id, reply_to_message_id: other.id, text: 'Thanks' }, token);
    assert.notEqual(viaOwn.json.error, DENIED);
    assert.match(viaOwn.json.error ?? '', /Agents may not send messages through "Hook"/);
    assert.equal(own.id, other.account_id);
  });
});

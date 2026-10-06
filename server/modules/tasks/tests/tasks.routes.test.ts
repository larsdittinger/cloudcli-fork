import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { tmpdir } from 'node:os';

import express from 'express';

import { channelAccountsDb, taskEventsDb, tasksDb } from '@/modules/database/index.js';
import { getTasksMcpToken } from '@/modules/tasks/mcp-registration.service.js';
import tasksMcpRoutes from '@/modules/tasks/tasks-mcp.routes.js';
import tasksRoutes from '@/modules/tasks/tasks.routes.js';
import { withIsolatedDatabase } from '@/modules/tasks/tests/helpers.js';
import { AppError } from '@/shared/utils.js';

/** An existing directory: agents may only create tasks in real project folders. */
const AGENT_DIR = tmpdir();

type Json = { success: boolean; data?: any; error?: { message?: string } | string };

async function startApi() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks-mcp', tasksMcpRoutes);
  app.use((req, _res, next) => { (req as unknown as { user: { id: number } }).user = { id: 7 }; next(); });
  app.use('/api/tasks', tasksRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ success: false, error: { message: err instanceof Error ? err.message : String(err) } });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const rest = async (method: string, url: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Json };
  };
  const tool = async (name: string, body: Record<string, unknown>, token = getTasksMcpToken()) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks-mcp/tools/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      // Agents call from their project directory; the tests act from AGENT_DIR unless they say otherwise.
      body: JSON.stringify({ cwd: AGENT_DIR, ...body }),
    });
    return { status: response.status, json: (await response.json()) as Json };
  };
  return { rest, tool, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('REST: create, list, detail, comment, answer, confirm, wake, status, summary, delete', async () => {
  await withIsolatedDatabase(async () => {
    const api = await startApi();
    try {
      const created = await api.rest('POST', '/', { title: 'Printer', brief: 'Three quotes', mandate: 'Email printers', projectPath: '/workspace/ceo_tasks' });
      assert.equal(created.status, 201);
      const id = created.json.data.id as number;
      assert.equal(created.json.data.ownerUserId, 7);

      assert.equal((await api.rest('POST', '/', { title: '', brief: 'x', projectPath: '/w' })).status, 400);
      assert.equal((await api.rest('GET', '/abc')).status, 400);
      assert.equal((await api.rest('GET', '/999')).status, 404);

      const list = await api.rest('GET', '/?projectPath=/workspace/ceo_tasks');
      assert.deepEqual(list.json.data.map((task: { id: number }) => task.id), [id]);
      assert.equal((await api.rest('GET', '/?projectPath=/elsewhere')).json.data.length, 0);

      assert.equal((await api.rest('POST', `/${id}/comment`, { text: 'Local printers please.' })).status, 200);
      assert.equal((await api.rest('POST', `/${id}/answer`, { option: 'A' })).status, 409);

      tasksDb.update(id, { status: 'waiting_owner', question: JSON.stringify({ text: 'Which?', options: ['A', 'B'], by: 'agent', askedAt: '' }) });
      assert.equal((await api.rest('GET', '/summary')).json.data.total, 1);
      const answered = await api.rest('POST', `/${id}/answer`, { option: 'B' });
      assert.equal(answered.json.data.status, 'working');

      assert.equal((await api.rest('POST', `/${id}/confirm-mandate`)).status, 200);
      assert.equal((await api.rest('POST', `/${id}/wake`)).status, 200);
      assert.equal((await api.rest('PUT', `/${id}`, { mandate: 'Email at most 3 printers.' })).json.data.mandate, 'Email at most 3 printers.');
      assert.equal((await api.rest('POST', `/${id}/status`, { status: 'nonsense' })).status, 400);
      assert.equal((await api.rest('POST', `/${id}/status`, { status: 'done' })).json.data.status, 'done');
      assert.equal((await api.rest('POST', `/${id}/wake`)).status, 409);

      const detail = await api.rest('GET', `/${id}`);
      assert.ok(detail.json.data.events.length >= 4);
      assert.deepEqual(detail.json.data.messages, []);

      assert.equal((await api.rest('DELETE', `/${id}`)).status, 200);
      assert.equal((await api.rest('GET', `/${id}`)).status, 404);
    } finally {
      await api.close();
    }
  });
});

test('MCP: token gate, info, create from cwd, update, log, ask, list, get, send without account', async () => {
  await withIsolatedDatabase(async () => {
    const api = await startApi();
    try {
      assert.equal((await api.tool('tasks_get_info', {}, 'wrong')).status, 401);
      channelAccountsDb.create({ type: 'email', label: 'Nákup', config: {}, secrets: {}, agentSend: 'auto' });

      const info = await api.tool('tasks_get_info', { cwd: AGENT_DIR });
      assert.equal(info.status, 200);
      assert.match(info.json.data.guide, /tasks_send_message/);
      assert.equal(info.json.data.state.channelAccounts[0].label, 'Nákup');

      const created = await api.tool('tasks_create', { title: 'Printer', brief: 'Quotes', mandate: 'Email printers', cwd: AGENT_DIR });
      assert.equal(created.status, 200);
      const id = created.json.data.task.id as number;
      assert.equal(created.json.data.task.projectPath, AGENT_DIR);
      assert.equal(created.json.data.task.mandateConfirmed, false);

      const updated = await api.tool('tasks_update', { id: `#${id}`, summary: 'Asked 3.', status: 'waiting_external', next_check_in_minutes: 60, checklist: [{ text: 'Ask', done: true }] });
      assert.equal(updated.json.data.status, 'waiting_external');
      assert.equal((await api.tool('tasks_update', { id, status: 'waiting_owner' })).status, 400);

      assert.equal((await api.tool('tasks_log', { id, text: 'Found 5 printers.' })).status, 200);
      const asked = await api.tool('tasks_ask_owner', { id, question: 'Which one?', options: ['A', 'B'] });
      assert.equal(asked.json.data.task.status, 'waiting_owner');

      const listed = await api.tool('tasks_list', {});
      assert.equal(listed.json.data[0].question, 'Which one?');
      const got = await api.tool('tasks_get', { id });
      assert.equal(got.json.data.task.summary, 'Asked 3.');
      assert.ok(got.json.data.events.some((event: { kind: string }) => event.kind === 'note'));

      const send = await api.tool('tasks_send_message', { task_id: id, to: 'a@print.cz', subject: 'Poptávka', text: 'Dobrý den' });
      assert.equal(send.status, 409, 'only a running task sends');
      tasksDb.setRunning(id, 'run-1', new Date().toISOString());
      const noAccount = await api.tool('tasks_send_message', { task_id: id, to: 'a@print.cz', subject: 'Poptávka', text: 'Dobrý den' });
      assert.equal(noAccount.status, 400);
      assert.match(String(noAccount.json.error), /account_id/);
      assert.equal((await api.tool('tasks_get', { id: 'x' })).status, 400);
      assert.equal((await api.tool('nope', {})).status, 404);
      assert.ok(taskEventsDb.count(id) > 0);
    } finally {
      await api.close();
    }
  });
});

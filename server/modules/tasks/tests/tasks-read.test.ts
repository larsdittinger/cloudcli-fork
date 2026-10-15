import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import express from 'express';

import { channelOutboxDb, tasksDb } from '@/modules/database/index.js';
import tasksRoutes from '@/modules/tasks/tasks.routes.js';
import { taskInput, withIsolatedDatabase } from '@/modules/tasks/tests/helpers.js';
import { AppError } from '@/shared/utils.js';

type Json = { success: boolean; data?: any };

async function startApi() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err instanceof AppError ? err.statusCode : 500).json({ success: false });
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
  return { rest, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('mark read clears the badge until something new needs the owner', async () => {
  await withIsolatedDatabase(async () => {
    const api = await startApi();
    try {
      const asked = tasksDb.create(taskInput({ status: 'waiting_owner', question: JSON.stringify({ text: 'Which?', options: ['A'], by: 'agent', askedAt: '2026-10-15T08:00:00.000Z' }) }));
      const unconfirmed = tasksDb.create(taskInput({ mandate_confirmed: 0, project_path: '/workspace/other' }));
      const quiet = tasksDb.create(taskInput({ title: 'Nothing to decide' }));
      assert.equal((await api.rest('GET', '/summary')).json.data.total, 2);

      assert.equal((await api.rest('POST', '/mark-read', { ids: ['x'] })).status, 400);
      const one = await api.rest('POST', '/mark-read', { ids: [asked.id, quiet.id] });
      assert.equal(one.json.data.updated, 1, 'a task that needs nothing has nothing to read');
      assert.equal((await api.rest('GET', '/summary')).json.data.total, 1);
      const listed = (await api.rest('GET', '/')).json.data as Array<{ id: number; attentionRead: boolean; question: unknown }>;
      const askedPublic = listed.find((task) => task.id === asked.id);
      assert.equal(askedPublic?.attentionRead, true);
      // Nothing was answered: the question still waits.
      assert.ok(askedPublic?.question);

      // A new draft is something new: the task counts again.
      channelOutboxDb.create({ accountId: 'acc', to: 'x@example.com', text: 'Quote?', status: 'draft', createdBy: 'agent', taskId: asked.id });
      assert.equal((await api.rest('GET', '/summary')).json.data.total, 2);

      // `all` within one project leaves the other project's badge alone.
      await api.rest('POST', '/mark-read', { all: true, projectPath: '/workspace/shop' });
      assert.deepEqual((await api.rest('GET', '/summary')).json.data.byProject, { '/workspace/other': 1 });
      await api.rest('POST', '/mark-read', { all: true });
      assert.equal((await api.rest('GET', '/summary')).json.data.total, 0);
      assert.equal(tasksDb.get(unconfirmed.id)?.mandate_confirmed, 0, 'reading never confirms a mandate');

      // A new question re-raises it too.
      tasksDb.update(unconfirmed.id, { question: JSON.stringify({ text: 'Go?', options: ['Yes'], by: 'agent', askedAt: '2026-10-15T09:00:00.000Z' }) });
      assert.equal((await api.rest('GET', '/summary')).json.data.total, 1);
    } finally {
      await api.close();
    }
  });
});

test('bulk delete removes the tasks that exist and skips the rest', async () => {
  await withIsolatedDatabase(async () => {
    const api = await startApi();
    try {
      const keep = tasksDb.create(taskInput());
      const first = tasksDb.create(taskInput({ title: 'Old one' }));
      const second = tasksDb.create(taskInput({ title: 'Older one' }));
      assert.equal((await api.rest('POST', '/delete', { ids: [] })).status, 400);
      const deleted = await api.rest('POST', '/delete', { ids: [first.id, second.id, 9999] });
      assert.equal(deleted.json.data.deleted, 2);
      assert.equal(tasksDb.get(first.id), null);
      assert.equal(tasksDb.get(second.id), null);
      assert.ok(tasksDb.get(keep.id));
    } finally {
      await api.close();
    }
  });
});

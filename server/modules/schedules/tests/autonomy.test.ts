import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { schedulesDb } from '@/modules/database/index.js';
import { getSchedulesMcpToken } from '@/modules/schedules/mcp-registration.service.js';
import { closeScheduler, initializeScheduler } from '@/modules/schedules/scheduler.service.js';
import schedulesMcpRoutes from '@/modules/schedules/schedules-mcp.routes.js';
import schedulesRoutes from '@/modules/schedules/schedules.routes.js';
import { withIsolatedDatabase } from '@/modules/schedules/tests/helpers.js';
import { AppError } from '@/shared/utils.js';

async function startApi() {
  const app = express();
  app.use(express.json());
  app.use('/api/schedules-mcp', schedulesMcpRoutes);
  app.use('/api/schedules', schedulesRoutes);
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

const proposal = (dir: string) => ({
  name: 'Daily check', kind: 'prompt', note: 'every morning', prompt: 'Check orders.', cwd: dir,
  schedule: { type: 'daily', time: '08:00' },
});

test('autonomy: agent schedules wait for approval by default, run right away with the switch on', async () => {
  await withIsolatedDatabase(async (dir) => {
    initializeScheduler(async () => {}, { tickMs: 0 });
    const api = await startApi();
    try {
      const token = getSchedulesMcpToken();
      assert.equal((await api.call('GET', '/api/schedules/settings')).json.data.agentsAutoApprove, false);
      const pending = await api.call('POST', '/api/schedules-mcp/tools/schedules_propose', proposal(dir), token);
      assert.ok(schedulesDb.get(pending.json.data.schedule.id)?.proposal);

      assert.equal((await api.call('PUT', '/api/schedules/settings', { agentsAutoApprove: 1 })).status, 400);
      assert.equal((await api.call('PUT', '/api/schedules/settings', { agentsAutoApprove: true })).json.data.agentsAutoApprove, true);
      const live = await api.call('POST', '/api/schedules-mcp/tools/schedules_propose', proposal(dir), token);
      const row = schedulesDb.get(live.json.data.schedule.id);
      assert.equal(row?.proposal, null);
      assert.equal(row?.enabled, 1);
      assert.ok(row?.next_run_at);
      assert.match(live.json.data.note, /without approval/i);

      const info = await api.call('POST', '/api/schedules-mcp/tools/schedules_get_info', { cwd: dir }, token);
      assert.equal(info.json.data.state.agentsAutoApprove, true);
    } finally {
      await api.close();
      closeScheduler();
    }
  });
});

test('autonomy: a one-time proposal already in the past stays a proposal even with the switch on', async () => {
  await withIsolatedDatabase(async (dir) => {
    initializeScheduler(async () => {}, { tickMs: 0 });
    const api = await startApi();
    try {
      await api.call('PUT', '/api/schedules/settings', { agentsAutoApprove: true });
      const past = await api.call('POST', '/api/schedules-mcp/tools/schedules_propose', { ...proposal(dir), schedule: { type: 'once', at: '2020-01-01T08:00:00.000Z' } }, getSchedulesMcpToken());
      if (past.status === 200) assert.ok(schedulesDb.get(past.json.data.schedule.id)?.proposal);
      else assert.equal(past.status, 400);
    } finally {
      await api.close();
      closeScheduler();
    }
  });
});

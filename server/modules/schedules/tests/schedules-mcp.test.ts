import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { schedulesDb } from '@/modules/database/index.js';
import { getSchedulesMcpToken } from '@/modules/schedules/mcp-registration.service.js';
import { closeScheduler, initializeScheduler } from '@/modules/schedules/scheduler.service.js';
import schedulesMcpRoutes from '@/modules/schedules/schedules-mcp.routes.js';
import { scheduleInput, withIsolatedDatabase } from '@/modules/schedules/tests/helpers.js';

async function startMcpApi() {
  const app = express();
  app.use(express.json());
  app.use('/api/schedules-mcp', schedulesMcpRoutes);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const call = async (tool: string, body: Record<string, unknown>, token = getSchedulesMcpToken()) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/schedules-mcp/tools/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as { success: boolean; data?: any; error?: string } };
  };
  return { call, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('MCP: token gate, info, propose (disabled until approved), withdraw only proposals, list runs', async () => {
  await withIsolatedDatabase(async (dir) => {
    initializeScheduler(async () => {}, { tickMs: 0 });
    const api = await startMcpApi();
    try {
      assert.equal((await api.call('schedules_get_info', {}, 'wrong')).status, 401);

      const info = await api.call('schedules_get_info', { cwd: dir });
      assert.equal(info.status, 200);
      assert.match(info.json.data.guide, /schedules_propose/);
      assert.equal(info.json.data.state.yourWorkingDirectory, dir);

      const invalid = await api.call('schedules_propose', { name: 'x', kind: 'prompt', prompt: 'p', schedule: { type: 'daily', time: '99:00' }, note: 'n', cwd: dir });
      assert.equal(invalid.status, 400);
      assert.match(invalid.json.error ?? '', /time/i);

      const proposed = await api.call('schedules_propose', {
        name: 'Ranní pošta', kind: 'script', command: './check_mail.py', handoff: 'on_output', prompt: 'Vyřiď: {{output}}',
        schedule: { type: 'interval', every: 10, unit: 'minutes' }, note: 'Každých 10 min zkontroluje poštu.', cwd: dir,
      });
      assert.equal(proposed.status, 200);
      const schedule = proposed.json.data.schedule;
      assert.equal(schedule.enabled, false);
      assert.equal(schedule.projectPath, dir, 'project defaults to the agent cwd');
      assert.equal(schedule.proposal.note, 'Každých 10 min zkontroluje poštu.');
      assert.equal(proposed.json.data.nextRuns.length, 3);

      const approved = schedulesDb.create(scheduleInput({ project_path: dir }));
      assert.equal((await api.call('schedules_withdraw_proposal', { id: approved.id })).status, 403);
      assert.ok(schedulesDb.get(approved.id));
      assert.equal((await api.call('schedules_withdraw_proposal', { id: schedule.id })).status, 200);
      assert.equal(schedulesDb.get(schedule.id), null);

      const runs = await api.call('schedules_list_runs', { schedule_id: approved.id });
      assert.equal(runs.status, 200);
      assert.deepEqual(runs.json.data, []);
    } finally {
      closeScheduler();
      await api.close();
    }
  });
});

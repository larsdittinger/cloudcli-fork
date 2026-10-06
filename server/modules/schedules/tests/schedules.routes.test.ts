import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { scheduleRunsDb, schedulesDb } from '@/modules/database/index.js';
import type { ScheduleRow, ScheduleRunRow } from '@/modules/database/index.js';
import { closeScheduler, initializeScheduler, settleRunningSchedules } from '@/modules/schedules/scheduler.service.js';
import schedulesRoutes from '@/modules/schedules/schedules.routes.js';
import { schedulesService } from '@/modules/schedules/schedules.service.js';
import { withIsolatedDatabase } from '@/modules/schedules/tests/helpers.js';
import { AppError } from '@/shared/utils.js';

async function startApi() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { user: { id: number } }).user = { id: 1 }; next(); });
  app.use('/api/schedules', schedulesRoutes);
  // Same shape as the server's global error middleware.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ success: false, error: { message: err instanceof Error ? err.message : String(err) } });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/schedules${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as { success: boolean; data?: any; error?: { message?: string } | string } };
  };
  return { call, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const errorText = (json: { error?: { message?: string } | string }) => (typeof json.error === 'string' ? json.error : json.error?.message ?? '');

test('REST: create validates, lists per project, computes summary and next run', async () => {
  await withIsolatedDatabase(async (dir) => {
    initializeScheduler(async () => {}, { tickMs: 0 });
    const api = await startApi();
    try {
      const bad = await api.call('POST', '/', { name: 'x', projectPath: dir, kind: 'prompt', prompt: '', schedule: { type: 'daily', time: '08:00' } });
      assert.equal(bad.status, 400);
      assert.match(errorText(bad.json), /prompt/i);

      const badSpec = await api.call('POST', '/', { name: 'x', projectPath: dir, kind: 'prompt', prompt: 'p', schedule: { type: 'weekly', days: [], time: '08:00' } });
      assert.equal(badSpec.status, 400);
      assert.match(errorText(badSpec.json), /day/i);

      const created = await api.call('POST', '/', {
        name: 'Kontrola', projectPath: dir, kind: 'prompt', prompt: 'Zkontroluj objednávky.',
        schedule: { type: 'weekly', days: [2, 4], time: '08:00' },
      });
      assert.equal(created.status, 201);
      assert.equal(created.json.data.summary, 'Every Tuesday, Thursday at 08:00');
      assert.equal(created.json.data.permissionMode, 'bypassPermissions');
      assert.equal(created.json.data.enabled, true);
      assert.ok(created.json.data.nextRunAt);
      assert.equal(schedulesDb.get(created.json.data.id)!.owner_user_id, 1);

      const script = await api.call('POST', '/', {
        name: 'Pošta', projectPath: '/elsewhere', kind: 'script', command: './check_mail.sh', handoff: 'on_output',
        schedule: { type: 'interval', every: 5, unit: 'minutes' },
      });
      assert.equal(script.status, 201);
      assert.equal(script.json.data.timeoutSec, 1800);

      assert.equal((await api.call('GET', `/?projectPath=${encodeURIComponent(dir)}`)).json.data.length, 1);
      assert.equal((await api.call('GET', '/')).json.data.length, 2);

      const paused = await api.call('PUT', `/${created.json.data.id}`, { enabled: false });
      assert.equal(paused.json.data.enabled, false);
      assert.equal(paused.json.data.nextRunAt, null);
      assert.equal(paused.json.data.prompt, 'Zkontroluj objednávky.', 'a partial update keeps the other fields');
    } finally {
      closeScheduler();
      await api.close();
    }
  });
});

test('REST: preview, run now, runs listing, duplicate, approve, delete', async () => {
  await withIsolatedDatabase(async (dir) => {
    const executed: string[] = [];
    initializeScheduler(async (schedule: ScheduleRow, run: ScheduleRunRow) => {
      executed.push(schedule.id);
      scheduleRunsDb.finish(run.id, { status: 'succeeded', finishedAt: new Date().toISOString(), output: 'hotovo' });
    }, { tickMs: 0 });
    const api = await startApi();
    try {
      const preview = await api.call('POST', '/preview', { schedule: { type: 'daily', time: '06:00' } });
      assert.equal(preview.status, 200);
      assert.equal(preview.json.data.summary, 'Daily at 06:00');
      assert.equal(preview.json.data.nextRuns.length, 3);
      assert.equal((await api.call('POST', '/preview', { schedule: { type: 'cron', expression: 'x' } })).status, 400);

      const created = (await api.call('POST', '/', { name: 'A', projectPath: dir, kind: 'prompt', prompt: 'p', schedule: { type: 'daily', time: '06:00' } })).json.data;
      const run = await api.call('POST', `/${created.id}/run`);
      assert.equal(run.status, 200);
      assert.equal(run.json.data.trigger, 'manual');
      await settleRunningSchedules();
      assert.deepEqual(executed, [created.id]);

      const runs = await api.call('GET', `/runs?scheduleId=${created.id}`);
      assert.equal(runs.json.data[0].status, 'succeeded');
      assert.equal(runs.json.data[0].scheduleName, 'A');
      assert.equal((await api.call('GET', `/runs/${runs.json.data[0].id}`)).json.data.output, 'hotovo');

      const copy = await api.call('POST', `/${created.id}/duplicate`);
      assert.equal(copy.json.data.name, 'A (copy)');
      assert.equal(copy.json.data.enabled, false, 'a copy starts paused so nothing runs twice');

      const proposal = schedulesService.create({ name: 'Agent', projectPath: dir, kind: 'prompt', prompt: 'p', schedule: { type: 'daily', time: '06:00' } }, null, { note: 'n', projectPath: dir, createdAt: 'x' });
      assert.equal(proposal.enabled, false);
      assert.equal(proposal.nextRunAt, null);
      assert.equal((await api.call('GET', '/summary')).json.data.proposals, 1);
      assert.equal((await api.call('POST', `/${proposal.id}/run`)).status, 409, 'a proposal cannot run before approval');
      const approved = await api.call('POST', `/${proposal.id}/approve`);
      assert.equal(approved.json.data.enabled, true);
      assert.equal(approved.json.data.proposal, null);
      assert.ok(approved.json.data.nextRunAt);

      assert.equal((await api.call('DELETE', `/${created.id}`)).status, 200);
      assert.equal(schedulesDb.get(created.id), null);
      assert.equal(scheduleRunsDb.list({ scheduleId: created.id }).length, 0);
    } finally {
      closeScheduler();
      await api.close();
    }
  });
});

test('REST: the full-log view of a truncated log still ends with the end of the output', async () => {
  await withIsolatedDatabase(async (dir) => {
    initializeScheduler(async () => {}, { tickMs: 0 });
    const api = await startApi();
    try {
      const created = (await api.call('POST', '/', { name: 'Big', projectPath: dir, kind: 'script', command: 'x', schedule: { type: 'daily', time: '06:00' } })).json.data;
      const logPath = `${dir}/big.log`;
      (await import('node:fs')).writeFileSync(logPath, '$ x\nSTART\n[log truncated at 1 MiB — the run keeps the last 64 KiB]\n');
      const run = scheduleRunsDb.create({ scheduleId: created.id, trigger: 'manual', scheduledFor: null, status: 'running' });
      scheduleRunsDb.finish(run.id, { status: 'failed', finishedAt: new Date().toISOString(), output: '...Error: disk full at the very end', logPath, exitCode: 1 });

      const full = await api.call('GET', `/runs/${run.id}?log=1`);
      assert.match(full.json.data.log, /START/);
      assert.match(full.json.data.log, /disk full at the very end/);
    } finally {
      closeScheduler();
      await api.close();
    }
  });
});

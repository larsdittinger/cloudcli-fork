import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { mock } from 'node:test';

import { projectsDb, schedulesDb } from '@/modules/database/index.js';
import { daemonClient, isolationDb, runTokens, type SpawnRequest } from '@/modules/isolation/index.js';
import { runScript } from '@/modules/schedules/script-runner.service.js';
import { scheduleInput, withIsolatedDatabase } from '@/modules/schedules/tests/helpers.js';

const ENV_KEYS = ['CLOUDCLI_ISOLATED_ROOT', 'CLOUDCLI_ISOLATED_HOMES', 'CLOUDCLI_ISOLATION_DIR', 'CLOUDCLI_SANDBOX_DAEMON_TOKEN'] as const;

async function withIsolatedProject(run: (dir: string, projectPath: string) => Promise<void>) {
  await withIsolatedDatabase(async (dir) => {
    const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.CLOUDCLI_ISOLATED_ROOT = path.join(dir, 'isolated');
    process.env.CLOUDCLI_ISOLATED_HOMES = path.join(dir, 'homes');
    process.env.CLOUDCLI_ISOLATION_DIR = path.join(dir, 'iso');
    process.env.CLOUDCLI_SANDBOX_DAEMON_TOKEN = 'daemon-token';
    const projectPath = path.join(dir, 'isolated', 'shop');
    fs.mkdirSync(projectPath, { recursive: true });
    fs.mkdirSync(path.join(dir, 'homes'), { recursive: true });
    try {
      const { project } = projectsDb.createProjectPath(projectPath, 'shop');
      isolationDb.markIsolated(project!.project_id, 20001);
      await run(dir, projectPath);
    } finally {
      for (const key of ENV_KEYS) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
}

function stubDaemon() {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kills: [] as string[],
    kill(signal: string) { proc.kills.push(signal); return true; },
  });
  const requests: SpawnRequest[] = [];
  const spawn = mock.method(daemonClient, 'spawn', ((request: SpawnRequest) => {
    requests.push(request);
    return proc as never;
  }) as never);
  return { proc, requests, restore: () => spawn.mock.restore() };
}

test('runScript: a script of an isolated project runs in the sandbox, not in the app', async () => {
  await withIsolatedProject(async (dir, projectPath) => {
    const marker = path.join(dir, 'ran-locally');
    const row = schedulesDb.create(scheduleInput({ kind: 'script', command: `touch ${marker}; echo hi`, project_path: projectPath, prompt: '' }));
    const { proc, requests, restore } = stubDaemon();
    try {
      const pending = runScript({ schedule: row, runId: 'iso-1', scheduledFor: null, logsDir: path.join(dir, 'logs') });
      await new Promise((r) => setImmediate(r));
      assert.equal(requests.length, 1);
      assert.equal(requests[0].kind, 'exec');
      assert.equal(requests[0].args[0], row.command);
      assert.equal(requests[0].env.CLOUDCLI_SCHEDULE_NAME, 'Daily check');
      assert.equal(requests[0].env.CLOUDCLI_RUN_ID, 'iso-1');
      assert.equal(runTokens.resolve(requests[0].env.CLOUDCLI_RUN_TOKEN)?.purpose, 'exec');
      proc.stdout.write('hi\n');
      proc.stderr.write('oops\n');
      proc.stdout.end();
      proc.emit('exit', 0, null);
      const result = await pending;
      assert.equal(result.status, 'succeeded');
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, 'hi\n');
      assert.match(result.output, /oops/);
      assert.ok(fs.readFileSync(result.logPath, 'utf8').includes('hi'));
      assert.equal(fs.existsSync(marker), false, 'nothing ran in the app');
    } finally {
      restore();
    }
  });
});

test('runScript: isolated script over its timeout is killed and marked timeout; non-zero exit fails', async () => {
  await withIsolatedProject(async (dir, projectPath) => {
    const row = schedulesDb.create(scheduleInput({ kind: 'script', command: 'sleep 99', project_path: projectPath, prompt: '' }));
    const { proc, restore } = stubDaemon();
    try {
      const pending = runScript({ schedule: row, runId: 'iso-2', scheduledFor: null, logsDir: path.join(dir, 'logs'), timeoutSec: 1, killGraceMs: 50 });
      await new Promise((r) => setTimeout(r, 1300));
      assert.deepEqual(proc.kills, ['SIGTERM', 'SIGKILL']);
      proc.stdout.end();
      proc.emit('exit', null, 'SIGKILL');
      const result = await pending;
      assert.equal(result.status, 'timeout');
    } finally {
      restore();
    }
  });
  await withIsolatedProject(async (dir, projectPath) => {
    const row = schedulesDb.create(scheduleInput({ kind: 'script', command: 'exit 2', project_path: projectPath, prompt: '' }));
    const { proc, restore } = stubDaemon();
    try {
      const pending = runScript({ schedule: row, runId: 'iso-3', scheduledFor: null, logsDir: path.join(dir, 'logs') });
      await new Promise((r) => setImmediate(r));
      proc.stdout.end();
      proc.emit('exit', 2, null);
      const result = await pending;
      assert.equal(result.status, 'failed');
      assert.equal(result.exitCode, 2);
    } finally {
      restore();
    }
  });
});

test('runScript: isolation unavailable fails the run with the sandbox text and runs nothing', async () => {
  await withIsolatedProject(async (dir, projectPath) => {
    const row = schedulesDb.create(scheduleInput({ kind: 'script', command: 'echo hi', project_path: projectPath, prompt: '' }));
    delete process.env.CLOUDCLI_ISOLATION_DIR;
    const { requests, restore } = stubDaemon();
    try {
      const result = await runScript({ schedule: row, runId: 'iso-4', scheduledFor: null, logsDir: path.join(dir, 'logs') });
      assert.equal(result.status, 'failed');
      assert.match(result.output, /Sandbox izolovaného projektu neběží/);
      assert.equal(requests.length, 0);
    } finally {
      restore();
    }
  });
});

// Main-side tools that run in a project directory (TaskMaster CLI, git worktrees, git of the agent API, cloning)
// are refused for isolated projects: the directory and its config are the agent's.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { projectsDb } from '@/modules/database/index.js';
import { isolationDb, refuseSpawnInIsolatedArea } from '@/modules/isolation/index.js';
import { isolationEnvFor, withIsolatedDatabase, withIsolationEnv } from '@/modules/isolation/tests/helpers.js';
import { taskmasterRoutes } from '@/modules/taskmaster/index.js';
import { worktreesRoutes } from '@/modules/worktrees/index.js';

async function withProjects(run: (ctx: { dir: string; isolatedId: string; isolatedRoot: string; plainId: string; base: string }) => Promise<void>) {
  await withIsolatedDatabase(async (dir) => {
    const env = isolationEnvFor(dir);
    await withIsolationEnv(env, async () => {
      const isolatedRoot = path.join(env.CLOUDCLI_ISOLATED_ROOT, 'agent');
      fs.mkdirSync(path.join(isolatedRoot, '.taskmaster', 'tasks'), { recursive: true });
      fs.writeFileSync(path.join(isolatedRoot, '.taskmaster', 'tasks', 'tasks.json'), '{"tasks":[]}');
      const isolatedId = projectsDb.createProjectPath(isolatedRoot, 'agent').project!.project_id;
      isolationDb.markIsolated(isolatedId, 20001);
      const plainRoot = path.join(dir, 'workspace', 'plain');
      fs.mkdirSync(plainRoot, { recursive: true });
      const plainId = projectsDb.createProjectPath(plainRoot, 'plain').project!.project_id;

      const app = express().use(express.json()).use('/api/taskmaster', taskmasterRoutes).use('/api/worktrees', worktreesRoutes);
      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        await run({ dir, isolatedId, isolatedRoot, plainId, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
}

test('TaskMaster and worktrees refuse isolated projects with 409, other projects still reach them', async () => {
  await withProjects(async ({ base, isolatedId, plainId }) => {
    for (const url of [`${base}/taskmaster/tasks/${isolatedId}`, `${base}/taskmaster/prd/${isolatedId}`, `${base}/worktrees?project=${isolatedId}`]) {
      const response = await fetch(url);
      assert.equal(response.status, 409, url);
      assert.match(await response.text(), /not available for isolated projects/);
    }
    const init = await fetch(`${base}/taskmaster/init/${isolatedId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(init.status, 409);

    const plain = await fetch(`${base}/taskmaster/tasks/${plainId}`);
    assert.notEqual(plain.status, 409);
    const plainWorktrees = await fetch(`${base}/worktrees?project=${plainId}`);
    assert.notEqual(plainWorktrees.status, 409);
  });
});

test('the agent API cannot run git in an isolated project', async () => {
  await withProjects(async ({ dir, isolatedRoot }) => {
    const calls: string[][] = [];
    const spawn = refuseSpawnInIsolatedArea(((command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      return { ok: true };
    }) as (command: string, args?: readonly string[], options?: { cwd?: string | URL }) => unknown, 'Git in the agent API');
    const refused = spawn('git', ['log'], { cwd: isolatedRoot }) as NodeJS.EventEmitter;
    const [error] = await once(refused, 'error');
    assert.match((error as Error).message, /not available for isolated projects/);
    const refusedClone = spawn('git', ['clone', '--', 'https://github.com/x/y', path.join(isolatedRoot, 'y')]) as NodeJS.EventEmitter;
    await once(refusedClone, 'error');
    assert.deepEqual(calls, []);
    assert.deepEqual(spawn('git', ['log'], { cwd: path.join(dir, 'workspace', 'plain') }), { ok: true });
  });
});

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { __testables } from '@/modules/browser-use/browser-use.service.js';
import browserUseRoutes from '@/modules/browser-use/browser-use.routes.js';
import { defaultEmulation } from '@/modules/browser-use/browser-emulation.js';
import { closeConnection, initializeDatabase, projectsDb, userDb, userProjectAccessDb } from '@/modules/database/index.js';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'browser-use-restricted-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    __testables.sessions.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function withServer(
  user: { id: number; role: 'admin' | 'restricted' },
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    (request as express.Request & { user?: typeof user }).user = user;
    next();
  });
  app.use('/api/browser-use', browserUseRoutes);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function listSessionIds(response: Response): Promise<string[]> {
  const body = await response.json() as { data: { sessions: Array<{ id: string }> } };
  return body.data.sessions.map((session) => session.id);
}

function addStoppedSession(id: string, projectPath: string | null): void {
  const now = new Date().toISOString();
  __testables.sessions.set(id, {
    id,
    ownerId: 'agent',
    createdBy: 'agent',
    runtime: 'local',
    status: 'stopped',
    url: null,
    title: null,
    screenshotDataUrl: null,
    createdAt: now,
    updatedAt: now,
    lastAction: null,
    message: null,
    profileName: null,
    projectPath,
    viewport: null,
    emulation: defaultEmulation(),
    cursor: null,
  });
}

test('restricted user sees and controls only browser sessions of granted projects', async () => {
  await withIsolatedDatabase(async () => {
    userDb.createUser('admin', 'hash');
    const viewer = userDb.createUserWithRole('viewer', 'hash', 'restricted');
    const granted = projectsDb.createProjectPath('/workspace/granted');
    projectsDb.createProjectPath('/workspace/other');
    userProjectAccessDb.setProjectsForUser(Number(viewer.id), [granted.project!.project_id]);

    addStoppedSession('mine', '/workspace/granted');
    addStoppedSession('theirs', '/workspace/other');
    addStoppedSession('unknown', null);

    await withServer({ id: Number(viewer.id), role: 'restricted' }, async (baseUrl) => {
      const list = await fetch(`${baseUrl}/api/browser-use/sessions`);
      assert.equal(list.status, 200);
      assert.deepEqual(await listSessionIds(list), ['mine']);

      assert.equal((await fetch(`${baseUrl}/api/browser-use/settings`)).status, 200);
      assert.equal((await fetch(`${baseUrl}/api/browser-use/status`)).status, 200);

      assert.equal((await fetch(`${baseUrl}/api/browser-use/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })).status, 403);
      assert.equal((await fetch(`${baseUrl}/api/browser-use/runtime/install`, { method: 'POST' })).status, 403);

      for (const id of ['theirs', 'unknown']) {
        assert.equal((await fetch(`${baseUrl}/api/browser-use/sessions/${id}/stop`, { method: 'POST' })).status, 403);
        assert.equal((await fetch(`${baseUrl}/api/browser-use/sessions/${id}`, { method: 'DELETE' })).status, 403);
        assert.equal((await fetch(`${baseUrl}/api/browser-use/sessions/${id}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'refresh' }),
        })).status, 403);
        assert.equal((await fetch(`${baseUrl}/api/browser-use/sessions/${id}/devtools`)).status, 403);
        assert.equal((await fetch(`${baseUrl}/api/browser-use/sessions/${id}/emulate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device: 'desktop' }),
        })).status, 403);
      }

      const stopMine = await fetch(`${baseUrl}/api/browser-use/sessions/mine/stop`, { method: 'POST' });
      assert.equal(stopMine.status, 200);
    });
  });
});

test('admin sees every browser session', async () => {
  await withIsolatedDatabase(async () => {
    const admin = userDb.createUser('admin', 'hash');
    addStoppedSession('a', '/workspace/granted');
    addStoppedSession('b', null);

    await withServer({ id: Number(admin.id), role: 'admin' }, async (baseUrl) => {
      const list = await fetch(`${baseUrl}/api/browser-use/sessions`);
      assert.deepEqual((await listSessionIds(list)).sort(), ['a', 'b']);
    });
  });
});

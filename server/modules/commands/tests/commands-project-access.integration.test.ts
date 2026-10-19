/**
 * Slash commands read `.claude/commands` of the project the request names, so
 * a restricted user may name only a project they were granted.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, projectsDb, userDb, userProjectAccessDb } from '@/modules/database/index.js';

type TestUser = { id: number; role: 'admin' | 'restricted' };

async function withCommandsServer(
  seed: () => TestUser,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'commands-access-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  const user = seed();

  const { commandsRoutes } = await import('@/modules/commands/index.js');
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    (request as express.Request & { user?: TestUser }).user = user;
    next();
  });
  app.use('/api/commands', commandsRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** A restricted user granted `/workspace/demo` but not `/workspace/secret`. */
function seedRestrictedUser(): TestUser {
  const created = userDb.createUserWithRole('viewer', 'hash', 'restricted');
  projectsDb.createProjectPath('/workspace/demo');
  projectsDb.createProjectPath('/workspace/secret');
  const demoId = projectsDb.getProjectPath('/workspace/demo')?.project_id ?? '';
  userProjectAccessDb.setProjectsForUser(Number(created.id), [demoId]);
  return { id: Number(created.id), role: 'restricted' };
}

const post = (baseUrl: string, route: string, body: unknown) => fetch(`${baseUrl}/api/commands${route}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('a restricted user cannot list or expand commands of a project they were not granted', async () => {
  await withCommandsServer(seedRestrictedUser, async (baseUrl) => {
    const listed = await post(baseUrl, '/list', { projectPath: '/workspace/secret' });
    assert.equal(listed.status, 403);

    const executed = await post(baseUrl, '/execute', {
      commandName: '/deploy',
      commandPath: '/workspace/secret/.claude/commands/deploy.md',
      context: { projectPath: '/workspace/secret' },
    });
    assert.equal(executed.status, 403);
  });
});

test('a restricted user lists the commands of their own project', async () => {
  await withCommandsServer(seedRestrictedUser, async (baseUrl) => {
    const listed = await post(baseUrl, '/list', { projectPath: '/workspace/demo' });
    assert.equal(listed.status, 200);
  });
});

test('an admin lists the commands of any project', async () => {
  await withCommandsServer(() => ({ id: 1, role: 'admin' }), async (baseUrl) => {
    const listed = await post(baseUrl, '/list', { projectPath: '/workspace/secret' });
    assert.equal(listed.status, 200);
  });
});

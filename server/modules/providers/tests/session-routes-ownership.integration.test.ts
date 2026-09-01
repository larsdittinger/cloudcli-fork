/**
 * Session routes must refuse a restricted user any session that is not theirs,
 * whichever endpoint they reach for. The guard is wired once for the whole
 * `:sessionId` family, so this exercises a representative spread of them.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb, userDb, userProjectAccessDb } from '@/modules/database/index.js';

type TestUser = { id: number; role: 'admin' | 'restricted' };

/**
 * Seeded users only exist once the isolated database is up, so the request user
 * may also be supplied as a callback resolved per request.
 */
async function withProviderServer(
  user: TestUser | (() => TestUser),
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-routes-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  // Imported after DATABASE_PATH is set so the router binds to the test database.
  const { default: providerRoutes } = await import('@/modules/providers/provider.routes.js');

  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    (request as express.Request & { user?: TestUser }).user =
      typeof user === 'function' ? user() : user;
    next();
  });
  app.use('/api/providers', providerRoutes);
  app.use((
    error: { statusCode?: number; code?: string; message?: string },
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    response.status(error.statusCode ?? 500).json({ error: error.message, code: error.code });
  });

  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  try {
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

/** Creates a restricted user granted the demo project, and returns their id. */
function grantDemoProjectToRestrictedUser(): number {
  const user = userDb.createUserWithRole('viewer', 'hash', 'restricted');
  projectsDb.createProjectPath('/workspace/demo');
  const projectId = projectsDb.getProjectPath('/workspace/demo')?.project_id ?? '';
  userProjectAccessDb.setProjectsForUser(Number(user.id), [projectId]);
  return Number(user.id);
}

const SOMEONE_ELSES_SESSION_PATHS = [
  '/api/providers/sessions/theirs-1',
  '/api/providers/sessions/theirs-1/messages',
  '/api/providers/sessions/theirs-1/token-usage',
  '/api/providers/sessions/theirs-1/provider-id',
  '/api/providers/claude/sessions/theirs-1/active-model',
];

test('a restricted user is refused every route for a session they do not own', async () => {
  await withProviderServer({ id: 7, role: 'restricted' }, async (baseUrl) => {
    sessionsDb.createAppSession('theirs-1', 'claude', '/workspace/demo', 'Theirs', 9);

    for (const routePath of SOMEONE_ELSES_SESSION_PATHS) {
      const response = await fetch(`${baseUrl}${routePath}`);
      assert.equal(response.status, 403, `expected 403 for ${routePath}`);
      assert.equal(((await response.json()) as { code?: string }).code, 'SESSION_ACCESS_DENIED');
    }
  });
});

test('a restricted user is refused deleting and renaming a session they do not own', async () => {
  await withProviderServer({ id: 7, role: 'restricted' }, async (baseUrl) => {
    sessionsDb.createAppSession('theirs-1', 'claude', '/workspace/demo', 'Theirs', 9);

    const deleteResponse = await fetch(`${baseUrl}/api/providers/sessions/theirs-1`, {
      method: 'DELETE',
    });
    assert.equal(deleteResponse.status, 403);

    const renameResponse = await fetch(`${baseUrl}/api/providers/sessions/theirs-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'stolen' }),
    });
    assert.equal(renameResponse.status, 403);
    assert.equal(sessionsDb.getSessionById('theirs-1')?.custom_name, 'Theirs');
  });
});

test('a restricted user reaches their own session', async () => {
  await withProviderServer({ id: 7, role: 'restricted' }, async (baseUrl) => {
    sessionsDb.createAppSession('mine-1', 'claude', '/workspace/demo', 'Mine', 7);

    const response = await fetch(`${baseUrl}/api/providers/sessions/mine-1`);
    assert.equal(response.status, 200);
  });
});

test('an admin reaches a restricted user session', async () => {
  await withProviderServer({ id: 1, role: 'admin' }, async (baseUrl) => {
    sessionsDb.createAppSession('theirs-1', 'claude', '/workspace/demo', 'Theirs', 9);

    const response = await fetch(`${baseUrl}/api/providers/sessions/theirs-1`);
    assert.equal(response.status, 200);
  });
});

test('the recent feed and the archive only list the restricted user own sessions', async () => {
  await withProviderServer({ id: 7, role: 'restricted' }, async (baseUrl) => {
    sessionsDb.createAppSession('mine-1', 'claude', '/workspace/demo', 'Mine', 7);
    sessionsDb.createAppSession('theirs-1', 'claude', '/workspace/demo', 'Theirs', 9);
    sessionsDb.createSession('orphan-1', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('mine-archived', 'claude', '/workspace/demo', 'Mine old', 7);
    sessionsDb.createAppSession('theirs-archived', 'claude', '/workspace/demo', 'Theirs old', 9);
    sessionsDb.updateSessionIsArchived('mine-archived', true);
    sessionsDb.updateSessionIsArchived('theirs-archived', true);

    const recent = await (await fetch(`${baseUrl}/api/providers/sessions/recent`)).json() as {
      data: { conversations: Array<{ sessionId: string }> };
    };
    assert.deepEqual(recent.data.conversations.map((item) => item.sessionId), ['mine-1']);

    const archived = await (await fetch(`${baseUrl}/api/providers/sessions/archived`)).json() as {
      data: { sessions: Array<{ sessionId: string }> };
    };
    assert.deepEqual(archived.data.sessions.map((item) => item.sessionId), ['mine-archived']);
  });
});

test('a new chat records the restricted user as its owner', async () => {
  let viewer: TestUser = { id: 0, role: 'restricted' };
  await withProviderServer(() => viewer, async (baseUrl) => {
    viewer = { id: grantDemoProjectToRestrictedUser(), role: 'restricted' };

    const response = await fetch(`${baseUrl}/api/providers/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'claude',
        projectPath: '/workspace/demo',
        initialMessage: 'ahoj',
      }),
    });

    assert.equal(response.status, 201);
    const created = (await response.json()) as { data: { sessionId: string } };
    assert.equal(sessionsDb.getSessionOwnerId(created.data.sessionId), viewer.id);
  });
});

test('a restricted user cannot start a chat in a project they were not granted', async () => {
  // Otherwise the project grants would be cosmetic: the session row carries the
  // working directory every later turn runs in, and it comes from this call.
  await withProviderServer({ id: 7, role: 'restricted' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/providers/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'claude',
        projectPath: '/workspace/not-mine',
        initialMessage: 'ahoj',
      }),
    });

    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { code?: string }).code, 'PROJECT_ACCESS_DENIED');
  });
});

test('a restricted user can start a chat in a granted project', async () => {
  let viewer: TestUser = { id: 0, role: 'restricted' };
  await withProviderServer(() => viewer, async (baseUrl) => {
    viewer = { id: grantDemoProjectToRestrictedUser(), role: 'restricted' };

    const response = await fetch(`${baseUrl}/api/providers/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'claude',
        projectPath: '/workspace/demo',
        initialMessage: 'ahoj',
      }),
    });

    assert.equal(response.status, 201);
  });
});

test('an admin can start a chat anywhere', async () => {
  await withProviderServer({ id: 1, role: 'admin' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/providers/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'claude',
        projectPath: '/workspace/anything',
        initialMessage: 'ahoj',
      }),
    });

    assert.equal(response.status, 201);
  });
});

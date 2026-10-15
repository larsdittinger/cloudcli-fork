/**
 * The sidebar must show a restricted user only their own chats inside the
 * projects they were granted, and page over that filtered set.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionSharesDb,
  sessionsDb,
  userDb,
  userProjectAccessDb,
} from '@/modules/database/index.js';

type TestUser = { id: number; role: 'admin' | 'restricted' };

/**
 * Seeded users only exist once the isolated database is up, so the request
 * user is resolved per request instead of being captured up front.
 */
async function withProjectsServer(
  readUser: () => TestUser,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'project-sessions-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const { default: projectRoutes } = await import('@/modules/projects/projects.routes.js');

  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    (request as express.Request & { user?: TestUser }).user = readUser();
    next();
  });
  app.use('/api/projects', projectRoutes);
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

/**
 * Seeds one granted project holding chats of two restricted users plus an
 * unowned one, and returns the viewer's id together with the project id.
 */
function seedSharedProject(): { viewerUserId: number; projectId: string } {
  userDb.createUser('boss', 'hash');
  const viewer = userDb.createUserWithRole('viewer', 'hash', 'restricted');
  const other = userDb.createUserWithRole('other', 'hash', 'restricted');
  const viewerUserId = Number(viewer.id);

  sessionsDb.createAppSession('mine-1', 'claude', '/workspace/demo', 'Mine', viewerUserId);
  sessionsDb.createAppSession('theirs-1', 'claude', '/workspace/demo', 'Theirs', Number(other.id));
  sessionsDb.createSession('orphan-1', 'claude', '/workspace/demo');

  const projectId = projectsDb.getProjectPath('/workspace/demo')?.project_id ?? '';
  userProjectAccessDb.setProjectsForUser(viewerUserId, [projectId]);
  return { viewerUserId, projectId };
}

test('the project list shows a restricted user only their own chats', async () => {
  let viewer: TestUser = { id: 0, role: 'restricted' };
  await withProjectsServer(() => viewer, async (baseUrl) => {
    viewer = { id: seedSharedProject().viewerUserId, role: 'restricted' };

    const projects = await (await fetch(`${baseUrl}/api/projects?skipSynchronization=1`)).json() as
      Array<{ sessions: Array<{ id: string }>; sessionMeta: { total: number; hasMore: boolean } }>;

    assert.equal(projects.length, 1);
    assert.deepEqual(projects[0].sessions.map((session) => session.id), ['mine-1']);
    assert.equal(projects[0].sessionMeta.total, 1);
    assert.equal(projects[0].sessionMeta.hasMore, false);
  });
});

test('the project session page is filtered and counted for the restricted user', async () => {
  let viewer: TestUser = { id: 0, role: 'restricted' };
  await withProjectsServer(() => viewer, async (baseUrl) => {
    const seeded = seedSharedProject();
    viewer = { id: seeded.viewerUserId, role: 'restricted' };
    const { projectId } = seeded;

    const page = await (await fetch(`${baseUrl}/api/projects/${projectId}/sessions`)).json() as {
      sessions: Array<{ id: string }>;
      sessionMeta: { total: number; hasMore: boolean };
    };

    assert.deepEqual(page.sessions.map((session) => session.id), ['mine-1']);
    assert.equal(page.sessionMeta.total, 1);
    assert.equal(page.sessionMeta.hasMore, false);
  });
});

test('an admin keeps seeing every chat in the project', async () => {
  await withProjectsServer(() => ({ id: 1, role: 'admin' }), async (baseUrl) => {
    seedSharedProject();

    const projects = await (await fetch(`${baseUrl}/api/projects?skipSynchronization=1`)).json() as
      Array<{ sessions: Array<{ id: string }>; sessionMeta: { total: number } }>;

    assert.equal(projects[0].sessions.length, 3);
    assert.equal(projects[0].sessionMeta.total, 3);
  });
});

test('a chat shared from an unassigned project shows that project as sharedOnly, read-only', async () => {
  let viewer: TestUser = { id: 0, role: 'restricted' };
  await withProjectsServer(() => viewer, async (baseUrl) => {
    const seeded = seedSharedProject();
    viewer = { id: seeded.viewerUserId, role: 'restricted' };
    sessionsDb.createAppSession('ceo-shared', 'claude', '/workspace/ceo', 'Shared', null);
    sessionsDb.createAppSession('ceo-private', 'claude', '/workspace/ceo', 'Private', null);
    sessionSharesDb.setUsersForSession('ceo-shared', [seeded.viewerUserId]);
    const ceoProjectId = projectsDb.getProjectPath('/workspace/ceo')?.project_id ?? '';

    const projects = await (await fetch(`${baseUrl}/api/projects?skipSynchronization=1`)).json() as Array<{
      projectId: string;
      sharedOnly?: boolean;
      sessions: Array<{ id: string; readOnly?: boolean }>;
    }>;
    const ceo = projects.find((project) => project.projectId === ceoProjectId);
    const demo = projects.find((project) => project.projectId === seeded.projectId);

    assert.equal(projects.length, 2);
    assert.equal(ceo?.sharedOnly, true);
    assert.deepEqual(ceo?.sessions.map((session) => [session.id, session.readOnly]), [['ceo-shared', true]]);
    assert.equal(demo?.sharedOnly, undefined);
    assert.deepEqual(demo?.sessions.map((session) => [session.id, session.readOnly]), [['mine-1', undefined]]);

    const page = await fetch(`${baseUrl}/api/projects/${ceoProjectId}/sessions`);
    assert.equal(page.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/projects/${ceoProjectId}/taskmaster`)).status, 403);
  });
});

test('"sees all chats" lists every chat of an assigned project read-only; admins see share counts', async () => {
  let user: TestUser = { id: 0, role: 'restricted' };
  await withProjectsServer(() => user, async (baseUrl) => {
    const seeded = seedSharedProject();
    userDb.setSeesAllSessions(seeded.viewerUserId, true);
    user = { id: seeded.viewerUserId, role: 'restricted' };

    const [project] = await (await fetch(`${baseUrl}/api/projects?skipSynchronization=1`)).json() as Array<{
      sessions: Array<{ id: string; readOnly?: boolean }>;
    }>;
    assert.deepEqual(
      project.sessions.map((session) => [session.id, session.readOnly]).sort(),
      [['mine-1', undefined], ['orphan-1', true], ['theirs-1', true]],
    );

    sessionSharesDb.setUsersForSession('orphan-1', [seeded.viewerUserId]);
    user = { id: 1, role: 'admin' };
    const [adminProject] = await (await fetch(`${baseUrl}/api/projects?skipSynchronization=1`)).json() as Array<{
      sessions: Array<{ id: string; sharedWith?: number }>;
    }>;
    assert.equal(adminProject.sessions.find((session) => session.id === 'orphan-1')?.sharedWith, 1);
    assert.equal(adminProject.sessions.find((session) => session.id === 'mine-1')?.sharedWith, undefined);
  });
});

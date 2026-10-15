/**
 * Scheduling a message, or queueing one in a draft, sends into the chat later
 * on the server's own initiative. Both are writes, so a restricted user may do
 * it only in a chat they own — not in one an admin merely shared with them.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, sessionSharesDb, sessionsDb, userDb } from '@/modules/database/index.js';

type TestUser = { id: number; role: 'admin' | 'restricted' };

async function withServer(readUser: () => TestUser, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'scheduled-access-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const { default: scheduledRoutes } = await import('@/modules/scheduled-messages/scheduled-messages.routes.js');
  const { userRoutes } = await import('@/modules/user/index.js');

  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    (request as express.Request & { user?: TestUser }).user = readUser();
    next();
  });
  app.use('/api/scheduled-messages', scheduledRoutes);
  app.use('/api/user', userRoutes);
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

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('a viewer cannot schedule or queue a message into a chat shared with them', async () => {
  let user: TestUser = { id: 0, role: 'restricted' };
  await withServer(() => user, async (baseUrl) => {
    userDb.createUser('admin', 'hash');
    const viewerId = Number(userDb.createUserWithRole('viewer', 'hash', 'restricted').id);
    user = { id: viewerId, role: 'restricted' };
    sessionsDb.createAppSession('ceo-1', 'claude', '/workspace/ceo', 'CEO chat', null);
    sessionsDb.createAppSession('mine-1', 'claude', '/workspace/ceo', 'Mine', viewerId);
    sessionSharesDb.setUsersForSession('ceo-1', [viewerId]);
    const inAMinute = new Date(Date.now() + 60_000).toISOString();

    const scheduled = await fetch(`${baseUrl}/api/scheduled-messages`, json('POST', {
      sessionId: 'ceo-1', content: 'hi', scheduledFor: inAMinute,
    }));
    assert.equal(scheduled.status, 403);

    const queued = await fetch(`${baseUrl}/api/user/drafts`, json('PUT', {
      scope: 'ceo-1', text: '', queuedMessage: { content: 'hi', options: {} },
    }));
    assert.equal(queued.status, 403);

    // A plain draft (nothing queued) and their own chat stay allowed.
    assert.equal((await fetch(`${baseUrl}/api/user/drafts`, json('PUT', { scope: 'ceo-1', text: 'note' }))).status, 200);
    const own = await fetch(`${baseUrl}/api/scheduled-messages`, json('POST', {
      sessionId: 'mine-1', content: 'hi', scheduledFor: inAMinute,
    }));
    assert.equal(own.status, 201);
  });
});

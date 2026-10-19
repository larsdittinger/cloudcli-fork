/**
 * Provider configuration is instance-wide: skills, MCP servers (whose env and
 * headers carry the cloudcli-* MCP tokens), custom models and Claude's own
 * settings files. A restricted user may chat, but never read or change them.
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

async function withProviderServer(
  user: TestUser | (() => TestUser),
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-admin-routes-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

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

const restricted: TestUser = { id: 7, role: 'restricted' };
const admin: TestUser = { id: 1, role: 'admin' };

/**
 * Every write here is invalid on purpose: an admin request then stops at
 * validation (400) instead of writing to this machine's provider config.
 */
const ADMIN_ONLY_ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'PUT', path: '/api/providers/claude/models/custom-only', body: {} },
  { method: 'POST', path: '/api/providers/claude/models', body: {} },
  { method: 'PATCH', path: '/api/providers/claude/models/1', body: {} },
  { method: 'DELETE', path: '/api/providers/claude/models/not-a-number' },
  { method: 'POST', path: '/api/providers/claude/skills', body: {} },
  { method: 'DELETE', path: '/api/providers/nope/skills/some-skill' },
  { method: 'GET', path: '/api/providers/claude/mcp/servers?scope=bogus' },
  { method: 'POST', path: '/api/providers/claude/mcp/servers', body: {} },
  { method: 'DELETE', path: '/api/providers/claude/mcp/servers/x?scope=bogus' },
  { method: 'POST', path: '/api/providers/mcp/servers/global', body: {} },
  { method: 'GET', path: '/api/providers/claude/settings-permissions' },
];

async function send(baseUrl: string, route: { method: string; path: string; body?: unknown }): Promise<Response> {
  return fetch(`${baseUrl}${route.path}`, {
    method: route.method,
    headers: route.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: route.body === undefined ? undefined : JSON.stringify(route.body),
  });
}

test('a restricted user is refused every provider configuration route', async () => {
  await withProviderServer(restricted, async (baseUrl) => {
    for (const route of ADMIN_ONLY_ROUTES) {
      const response = await send(baseUrl, route);
      assert.equal(response.status, 403, `expected 403 for ${route.method} ${route.path}`);
      assert.equal(((await response.json()) as { code?: string }).code, 'ADMIN_REQUIRED');
    }
  });
});

test('an admin passes the guard on the provider configuration routes', async () => {
  await withProviderServer(admin, async (baseUrl) => {
    for (const route of ADMIN_ONLY_ROUTES) {
      const response = await send(baseUrl, route);
      assert.notEqual(response.status, 403, `admin refused ${route.method} ${route.path}`);
    }
  });
});

test('a restricted user lists skills only for a project they were granted', async () => {
  let restrictedUser: TestUser = restricted;
  await withProviderServer(() => restrictedUser, async (baseUrl) => {
    const created = userDb.createUserWithRole('viewer', 'hash', 'restricted');
    restrictedUser = { id: Number(created.id), role: 'restricted' };
    projectsDb.createProjectPath('/workspace/demo');
    projectsDb.createProjectPath('/workspace/secret');
    const demoId = projectsDb.getProjectPath('/workspace/demo')?.project_id ?? '';
    userProjectAccessDb.setProjectsForUser(restrictedUser.id, [demoId]);

    const denied = await fetch(`${baseUrl}/api/providers/claude/skills?workspacePath=${encodeURIComponent('/workspace/secret')}`);
    assert.equal(denied.status, 403);
    assert.equal(((await denied.json()) as { code?: string }).code, 'PROJECT_ACCESS_DENIED');

    // The slash-command menu of their own chat still loads.
    const allowed = await fetch(`${baseUrl}/api/providers/claude/skills?workspacePath=${encodeURIComponent('/workspace/demo')}`);
    assert.equal(allowed.status, 200);
  });
});

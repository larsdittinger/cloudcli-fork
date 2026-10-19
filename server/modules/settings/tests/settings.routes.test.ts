import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createSettingsRouter } from '../settings.routes.js';

type TestUser = { id: number; role: 'admin' | 'restricted' };

/** Every service call answers with its own name, so a route that ran is visible. */
const service = new Proxy({}, {
  get: (_target, name) => () => ({ called: String(name) }),
}) as Parameters<typeof createSettingsRouter>[0];

async function withSettingsServer(user: TestUser, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    (request as express.Request & { user?: TestUser }).user = user;
    next();
  });
  app.use('/api/settings', createSettingsRouter(service));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// An API key opens the external Agent API, and credentials hold GitHub tokens
// that agent runs clone and push with: both are for admins only.
const ADMIN_ONLY_ROUTES = [
  ['GET', '/api/settings/api-keys'],
  ['POST', '/api/settings/api-keys'],
  ['DELETE', '/api/settings/api-keys/1'],
  ['PATCH', '/api/settings/api-keys/1/toggle'],
  ['GET', '/api/settings/credentials'],
  ['POST', '/api/settings/credentials'],
  ['DELETE', '/api/settings/credentials/1'],
  ['PATCH', '/api/settings/credentials/1/toggle'],
];

async function call(baseUrl: string, method: string, routePath: string): Promise<Response> {
  return fetch(`${baseUrl}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : '{}',
  });
}

test('a restricted user is refused API keys and credentials', async () => {
  await withSettingsServer({ id: 7, role: 'restricted' }, async (baseUrl) => {
    for (const [method, routePath] of ADMIN_ONLY_ROUTES) {
      const response = await call(baseUrl, method, routePath);
      assert.equal(response.status, 403, `expected 403 for ${method} ${routePath}`);
    }
  });
});

test('a restricted user keeps their own notification and push settings', async () => {
  await withSettingsServer({ id: 7, role: 'restricted' }, async (baseUrl) => {
    for (const [method, routePath] of [
      ['GET', '/api/settings/notification-preferences'],
      ['PUT', '/api/settings/notification-preferences'],
      ['GET', '/api/settings/push/vapid-public-key'],
      ['POST', '/api/settings/push/subscribe'],
      ['POST', '/api/settings/push/unsubscribe'],
    ]) {
      const response = await call(baseUrl, method, routePath);
      assert.equal(response.status, 200, `expected 200 for ${method} ${routePath}`);
    }
  });
});

test('an admin reaches API keys and credentials', async () => {
  await withSettingsServer({ id: 1, role: 'admin' }, async (baseUrl) => {
    for (const [method, routePath] of ADMIN_ONLY_ROUTES) {
      const response = await call(baseUrl, method, routePath);
      assert.equal(response.status, 200, `expected 200 for ${method} ${routePath}`);
    }
  });
});

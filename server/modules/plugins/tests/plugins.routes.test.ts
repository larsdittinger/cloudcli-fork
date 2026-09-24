import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createPluginsRouter } from '../plugins.routes.js';
import type { createPluginsService } from '../plugins.service.js';

type PluginsService = ReturnType<typeof createPluginsService>;

const plugins = [
  { name: 'claude-usage', dirName: 'cloudcli-plugin-claude-usage', enabled: true },
  { name: 'workspace-scheduled-prompts', dirName: 'cloudcli-cron', enabled: true },
];

const service = {
  list: () => ({ plugins }),
  getManifest: (name: string) => plugins.find((plugin) => plugin.name === name),
} as unknown as PluginsService;

async function withServer(role: string, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use((request, _response, next) => {
    (request as express.Request & { user?: { role: string } }).user = { role };
    next();
  });
  app.use('/api/plugins', createPluginsRouter(service));

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

test('restricted user sees and reaches only the allowed read-only plugins', async () => {
  await withServer('restricted', async (baseUrl) => {
    const list = await (await fetch(`${baseUrl}/api/plugins`)).json() as { plugins: { name: string }[] };
    assert.deepEqual(list.plugins.map((plugin) => plugin.name), ['claude-usage']);

    assert.equal((await fetch(`${baseUrl}/api/plugins/claude-usage/manifest`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/plugins/workspace-scheduled-prompts/manifest`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/plugins/workspace-scheduled-prompts/rpc/jobs`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/plugins/workspace-scheduled-prompts/assets/index.js`)).status, 404);
  });
});

test('admin sees every plugin', async () => {
  await withServer('admin', async (baseUrl) => {
    const list = await (await fetch(`${baseUrl}/api/plugins`)).json() as { plugins: { name: string }[] };
    assert.deepEqual(list.plugins.map((plugin) => plugin.name), ['claude-usage', 'workspace-scheduled-prompts']);
    assert.equal((await fetch(`${baseUrl}/api/plugins/workspace-scheduled-prompts/manifest`)).status, 200);
  });
});

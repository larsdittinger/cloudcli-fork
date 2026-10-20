import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { projectsDb } from '@/modules/database/index.js';
import { withTempDatabase } from '@/modules/projects/tests/copy-helpers.js';
import projectsRoutes from '@/modules/projects/projects.routes.js';
import { AppError } from '@/shared/utils.js';

async function withServer(role: 'admin' | 'restricted', run: (call: (method: string, url: string, body?: unknown) => Promise<{ status: number; json: any }>) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', (req, _res, next) => {
    (req as express.Request & { user?: unknown }).user = { id: 1, username: 'u', role };
    next();
  }, projectsRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err instanceof AppError ? err.statusCode : 500).json({ error: String(err) });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await run(async (method, url, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: await response.json() };
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('copy routes are admin-only', async () => {
  await withServer('restricted', async (call) => {
    assert.equal((await call('POST', '/api/projects/x/copy/preview')).status, 403);
    assert.equal((await call('POST', '/api/projects/x/copy', { name: 'n' })).status, 403);
    assert.equal((await call('GET', '/api/projects/copy-progress/abc')).status, 403);
    assert.equal((await call('POST', '/api/projects/copy-progress/abc/cancel')).status, 403);
  });
});

test('copy preview answers for admins, unknown ids and jobs are 404', async () => {
  await withTempDatabase(async (dir) => {
    const sourcePath = path.join(dir, 'src');
    fs.mkdirSync(sourcePath);
    fs.writeFileSync(path.join(sourcePath, 'a.txt'), 'abc');
    const projectId = projectsDb.createProjectPath(sourcePath, 'Src').project!.project_id;
    await withServer('admin', async (call) => {
      const preview = await call('POST', `/api/projects/${projectId}/copy/preview`);
      assert.equal(preview.status, 200);
      assert.equal(preview.json.fileCount, 1);
      assert.equal(preview.json.suggestedName, 'Src (kopie)');
      assert.equal((await call('POST', '/api/projects/nope/copy/preview')).status, 404);
      assert.equal((await call('GET', '/api/projects/copy-progress/nope')).status, 404);
      assert.equal((await call('POST', `/api/projects/${projectId}/copy`, { name: '' })).status, 400);
    });
  });
});

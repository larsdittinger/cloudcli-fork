// ISOLATED_ROOT lies outside WORKSPACES_ROOT (docker: /isolated vs /workspace). Registered isolated projects must
// still pass the workspace path policy; nothing else under the isolated root may.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { projectsDb } from '@/modules/database/index.js';
import { fileTreeRoutes } from '@/modules/file-tree/index.js';
import { isolationDb } from '@/modules/isolation/index.js';
import { withIsolationDirs, withTempDatabase } from '@/modules/projects/tests/copy-helpers.js';
import { validateWorkspacePath } from '@/shared/utils.js';

test('workspace policy accepts registered isolated projects (and their subdirectories) outside WORKSPACES_ROOT only', async () => {
  await withTempDatabase(async (dir) => {
    await withIsolationDirs(dir, async () => {
      const agent = path.join(dir, 'isolated', 'agent');
      fs.mkdirSync(path.join(agent, 'sub'), { recursive: true });
      const stray = path.join(dir, 'isolated', 'stray');
      fs.mkdirSync(stray);
      const plain = path.join(dir, 'plain');
      fs.mkdirSync(plain);
      const id = projectsDb.createProjectPath(agent, 'agent').project!.project_id;
      // Not yet isolated: refused like any path outside WORKSPACES_ROOT.
      assert.equal((await validateWorkspacePath(agent)).valid, false);
      isolationDb.markIsolated(id, isolationDb.allocateUid());
      assert.equal((await validateWorkspacePath(agent)).valid, true);
      assert.equal((await validateWorkspacePath(path.join(agent, 'sub'))).valid, true);
      assert.equal((await validateWorkspacePath(stray)).valid, false);
      assert.equal((await validateWorkspacePath(plain)).valid, false);
    });
  });
});

test('file tree browse and project listing work for an isolated project outside WORKSPACES_ROOT', async () => {
  await withTempDatabase(async (dir) => {
    await withIsolationDirs(dir, async () => {
      const agent = path.join(dir, 'isolated', 'agent');
      fs.mkdirSync(agent, { recursive: true });
      fs.writeFileSync(path.join(agent, 'a.txt'), 'x');
      const id = projectsDb.createProjectPath(agent, 'agent').project!.project_id;
      isolationDb.markIsolated(id, isolationDb.allocateUid());

      const app = express();
      app.use(express.json());
      app.use((request, _response, next) => {
        (request as express.Request & { user?: unknown }).user = { id: 1, username: 'admin', role: 'admin' };
        next();
      });
      app.use('/api/file-tree', fileTreeRoutes);
      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/file-tree`;
      try {
        const browse = await fetch(`${base}/browse-filesystem?path=${encodeURIComponent(agent)}`);
        assert.equal(browse.status, 200);
        // (A stray dir is not asserted here: the temp dir of this test is a read-only browse root.)
        const listing = await fetch(`${base}/projects/${id}/files`);
        assert.equal(listing.status, 200);
        assert.ok(JSON.stringify(await listing.json()).includes('a.txt'));
      } finally {
        server.close();
      }
    });
  });
});

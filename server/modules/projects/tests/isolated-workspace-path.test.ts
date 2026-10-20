// ISOLATED_ROOT lies outside WORKSPACES_ROOT (docker: /isolated vs /workspace). Registered isolated projects must
// still pass the workspace path policy; nothing else under the isolated root may.
//
// Not under os.tmpdir(): on Linux that is /tmp, a forbidden workspace location, so every path would be refused
// for the wrong reason. The test tree lives in the repository instead, with WORKSPACES_ROOT pointed at a sibling
// directory of it — set before any app module reads it, hence the dynamic imports.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

const TEST_BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.test-tmp');
fs.mkdirSync(TEST_BASE, { recursive: true });
const RUN_DIR = fs.realpathSync(fs.mkdtempSync(path.join(TEST_BASE, 'isolated-workspace-')));
process.env.WORKSPACES_ROOT = path.join(RUN_DIR, 'workspaces');
fs.mkdirSync(process.env.WORKSPACES_ROOT);

const { closeConnection, initializeDatabase, projectsDb } = await import('@/modules/database/index.js');
const { fileTreeRoutes } = await import('@/modules/file-tree/index.js');
const { createProject } = await import('@/modules/projects/services/project-management.service.js');
const { isolationDb } = await import('@/modules/isolation/index.js');
const { withIsolationDirs } = await import('@/modules/projects/tests/copy-helpers.js');
const { validateWorkspacePath } = await import('@/shared/utils.js');

after(() => {
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  try {
    fs.rmdirSync(TEST_BASE); // only when no other run left anything there
  } catch {
    // not empty
  }
});

let counter = 0;

/** A fresh SQLite file in its own directory under the repository's test tree. */
async function withTempDatabase(runTest: (dir: string) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  counter += 1;
  const dir = path.join(RUN_DIR, `case-${counter}`);
  fs.mkdirSync(dir);
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await runTest(dir);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
  }
}

test('the test tree is a legal location: neither under WORKSPACES_ROOT nor a forbidden system directory', async () => {
  const outside = path.join(RUN_DIR, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const inRoot = path.join(process.env.WORKSPACES_ROOT!, 'inside');
  fs.mkdirSync(inRoot, { recursive: true });
  assert.equal((await validateWorkspacePath(inRoot)).valid, true);
  assert.match((await validateWorkspacePath(outside)).error ?? '', /allowed workspace root/);
});

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
        const listing = await fetch(`${base}/projects/${id}/files`);
        assert.equal(listing.status, 200);
        assert.ok(JSON.stringify(await listing.json()).includes('a.txt'));
      } finally {
        server.close();
      }
    });
  });
});

test('create-project refuses a path inside an isolated project and creates nothing', async () => {
  await withTempDatabase(async (dir) => {
    await withIsolationDirs(dir, async () => {
      const agent = path.join(dir, 'isolated', 'agent');
      fs.mkdirSync(agent, { recursive: true });
      const id = projectsDb.createProjectPath(agent, 'agent').project!.project_id;
      isolationDb.markIsolated(id, isolationDb.allocateUid());
      const nested = path.join(agent, 'sub');
      await assert.rejects(createProject({ projectPath: nested }), (error: any) => error.statusCode === 409);
      assert.equal(fs.existsSync(nested), false);
      assert.equal(projectsDb.getProjectPath(nested), null);
    });
  });
});

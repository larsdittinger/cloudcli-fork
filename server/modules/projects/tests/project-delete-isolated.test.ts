import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { mock } from 'node:test';

import { projectsDb } from '@/modules/database/index.js';
import { daemonClient, isolationDb } from '@/modules/isolation/index.js';
import { deleteOrArchiveProject } from '@/modules/projects/services/project-delete.service.js';
import { withIsolationDirs, withTempDatabase } from '@/modules/projects/tests/copy-helpers.js';

test('deleting an isolated project removes it from the sandbox daemon; archiving does not', async () => {
  await withTempDatabase(async (dir) => {
    await withIsolationDirs(dir, async () => {
      const make = (name: string) => {
        const projectPath = path.join(dir, 'isolated', name);
        fs.mkdirSync(projectPath, { recursive: true });
        const id = projectsDb.createProjectPath(projectPath, name).project!.project_id;
        isolationDb.markIsolated(id, isolationDb.allocateUid());
        return id;
      };
      const archived = make('archived');
      const deleted = make('deleted');
      const plainPath = path.join(dir, 'plain');
      fs.mkdirSync(plainPath);
      const plain = projectsDb.createProjectPath(plainPath, 'plain').project!.project_id;
      const removed: string[] = [];
      const del = mock.method(daemonClient, 'deleteProject', async (id: string) => { removed.push(id); return { removed: true }; });
      try {
        await deleteOrArchiveProject(archived, false);
        await deleteOrArchiveProject(plain, true);
        assert.deepEqual(removed, []);
        await deleteOrArchiveProject(deleted, true);
        assert.deepEqual(removed, [deleted]);
        assert.equal(projectsDb.getProjectById(deleted), null);
      } finally {
        del.mock.restore();
      }

      // An unreachable daemon does not block the delete (the resync prunes it later).
      const again = make('again');
      const down = mock.method(daemonClient, 'deleteProject', async () => { throw new Error('Sandbox izolovaného projektu neběží (ENOENT)'); });
      try {
        await deleteOrArchiveProject(again, true);
        assert.equal(projectsDb.getProjectById(again), null);
      } finally {
        down.mock.restore();
      }
    });
  });
});

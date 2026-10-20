import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { projectsDb } from '@/modules/database/index.js';
import { isolationDb } from '@/modules/isolation/isolation.db.js';
import { isolationEnvFor, withIsolatedDatabase, withIsolationEnv } from '@/modules/isolation/tests/helpers.js';

function makeProject(dir: string, name: string): string {
  const projectPath = path.join(dir, 'isolated', name);
  fs.mkdirSync(projectPath, { recursive: true });
  return projectsDb.createProjectPath(projectPath, name).project!.project_id;
}

test('allocateUid never reuses a uid, even after the highest project is deleted', async () => {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      const a = makeProject(dir, 'a');
      const b = makeProject(dir, 'b');
      assert.equal(isolationDb.markIsolated(a, isolationDb.allocateUid()).uid, 20000);
      const second = isolationDb.markIsolated(b, isolationDb.allocateUid());
      assert.equal(second.uid, 20001);
      projectsDb.deleteProjectById(b);
      const c = makeProject(dir, 'c');
      assert.equal(isolationDb.markIsolated(c, isolationDb.allocateUid()).uid, 20002);
    });
  });
});

test('allocateUid starts above uids already in use when the counter is missing', async () => {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      const a = makeProject(dir, 'a');
      isolationDb.markIsolated(a, 20007); // e.g. a database from before the counter
      assert.equal(isolationDb.allocateUid(), 20008);
      assert.equal(isolationDb.allocateUid(), 20009);
    });
  });
});

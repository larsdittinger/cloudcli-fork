import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { mock } from 'node:test';

import { projectsDb } from '@/modules/database/index.js';
import { daemonClient, DaemonCallError } from '@/modules/isolation/daemon-client.js';
import { isolationDb } from '@/modules/isolation/isolation.db.js';
import { stageForSandbox } from '@/modules/isolation/sandbox-attachments.js';
import { isolationEnvFor, withIsolatedDatabase, withIsolationEnv } from '@/modules/isolation/tests/helpers.js';

async function withProject(run: (ctx: { dir: string; projectPath: string; source: string }) => Promise<void>) {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      const projectPath = path.join(dir, 'isolated', 'x');
      fs.mkdirSync(projectPath, { recursive: true });
      const { project } = projectsDb.createProjectPath(projectPath, 'x');
      isolationDb.markIsolated(project!.project_id, 20001);
      const source = path.join(dir, 'store', 'faktura.pdf');
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, 'PDF-DATA');
      await run({ dir, projectPath, source });
    });
  });
}

test('items of a project that is not isolated come back unchanged', async () => {
  await withProject(async ({ dir, source }) => {
    const items = [{ path: source, name: 'faktura.pdf' }];
    const adopt = mock.method(daemonClient, 'adopt', async () => ({ ok: true, warnings: [] }));
    try {
      assert.equal(await stageForSandbox(path.join(dir, 'plain'), 'm-1', items), items);
      assert.equal(adopt.mock.callCount(), 0);
    } finally {
      adopt.mock.restore();
    }
  });
});

test('files are copied into .cloudcli-attachments/<subdir> and handed to the project uid', async () => {
  await withProject(async ({ projectPath, source }) => {
    const calls: unknown[][] = [];
    const adopt = mock.method(daemonClient, 'adopt', async (...args: unknown[]) => {
      calls.push(args);
      return { ok: true, warnings: [] };
    });
    try {
      const [staged] = await stageForSandbox(projectPath, 'm-1', [{ path: source, name: 'faktura.pdf', mime: 'application/pdf', size: 8 }]);
      const expected = path.join(projectPath, '.cloudcli-attachments', 'm-1', 'faktura.pdf');
      assert.deepEqual(staged, { path: expected, name: 'faktura.pdf', mime: 'application/pdf', size: 8 });
      assert.equal(fs.readFileSync(expected, 'utf8'), 'PDF-DATA');
      assert.equal(fs.statSync(expected).mode & 0o777, 0o660);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0][1], ['.cloudcli-attachments/m-1']);
      // Staging the same message again replaces the copy.
      fs.writeFileSync(source, 'NEW');
      await stageForSandbox(projectPath, 'm-1', [{ path: source }]);
      assert.equal(fs.readFileSync(expected, 'utf8'), 'NEW');
    } finally {
      adopt.mock.restore();
    }
  });
});

test('a symlink planted by the agent is never written through', async () => {
  await withProject(async ({ dir, projectPath, source }) => {
    const adopt = mock.method(daemonClient, 'adopt', async () => ({ ok: true, warnings: [] }));
    try {
      const outside = path.join(dir, 'outside');
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(projectPath, '.cloudcli-attachments'));
      await assert.rejects(stageForSandbox(projectPath, 'm-1', [{ path: source }]));
      assert.deepEqual(fs.readdirSync(outside), []);

      fs.rmSync(path.join(projectPath, '.cloudcli-attachments'));
      fs.mkdirSync(path.join(projectPath, '.cloudcli-attachments'));
      fs.symlinkSync(outside, path.join(projectPath, '.cloudcli-attachments', 'm-2'));
      await assert.rejects(stageForSandbox(projectPath, 'm-2', [{ path: source }]));
      assert.deepEqual(fs.readdirSync(outside), []);

      fs.mkdirSync(path.join(projectPath, '.cloudcli-attachments', 'm-3'));
      fs.symlinkSync(path.join(outside, 'planted'), path.join(projectPath, '.cloudcli-attachments', 'm-3', 'faktura.pdf'));
      await stageForSandbox(projectPath, 'm-3', [{ path: source }]);
      assert.deepEqual(fs.readdirSync(outside), []);
      assert.equal(fs.lstatSync(path.join(projectPath, '.cloudcli-attachments', 'm-3', 'faktura.pdf')).isFile(), true);

      await assert.rejects(stageForSandbox(projectPath, '../m', [{ path: source }]), /subdir/);
    } finally {
      adopt.mock.restore();
    }
  });
});

test('a sandbox that cannot take the files over fails the staging', async () => {
  await withProject(async ({ projectPath, source }) => {
    const adopt = mock.method(daemonClient, 'adopt', async () => {
      throw new DaemonCallError(0, 'Sandbox izolovaného projektu neběží (connect ENOENT)');
    });
    try {
      await assert.rejects(stageForSandbox(projectPath, 'uploads', [{ path: source }]), /neběží/);
    } finally {
      adopt.mock.restore();
    }
  });
});

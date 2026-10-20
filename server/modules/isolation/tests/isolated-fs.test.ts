import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  isolatedAreaOf,
  isolatedFs,
  IsolatedPathRefusedError,
  openIsolatedPath,
} from '@/modules/isolation/isolated-fs.js';
import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { isolationDb } from '@/modules/isolation/isolation.db.js';
import { readTranscriptText } from '@/modules/isolation/isolation-transcripts.js';
import { isolationEnvFor, withIsolatedDatabase, withIsolationEnv } from '@/modules/isolation/tests/helpers.js';

async function withRoot(run: (ctx: { dir: string; root: string; project: string; secret: string }) => Promise<void>) {
  await withIsolatedDatabase(async (dir) => {
    const env = isolationEnvFor(dir);
    const project = path.join(env.CLOUDCLI_ISOLATED_ROOT, 'p');
    fs.mkdirSync(project, { recursive: true });
    const secret = path.join(dir, 'secret.txt');
    fs.writeFileSync(secret, 'main secret');
    await withIsolationEnv(env, () => run({ dir, root: env.CLOUDCLI_ISOLATED_ROOT, project, secret }));
  });
}

/** Fails the test instead of hanging when `promise` does not settle quickly (a FIFO that blocks). */
function within<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms);
    }),
  ]);
}

test('isolatedAreaOf: paths under the isolated root or homes, nothing else', async () => {
  await withRoot(async ({ dir, root, project }) => {
    assert.deepEqual(isolatedAreaOf(path.join(project, 'a', 'b.txt')), { root, rel: path.join('p', 'a', 'b.txt') });
    assert.deepEqual(isolatedAreaOf(root), { root, rel: '' });
    assert.equal(isolatedAreaOf(path.join(dir, 'homes', 'x', '.claude'))?.rel, path.join('x', '.claude'));
    assert.equal(isolatedAreaOf(path.join(dir, 'workspace', 'p')), null);
    assert.equal(isolatedAreaOf(`${root}-other/x`), null);
  });
  await withIsolationEnv(null, () => {
    assert.equal(isolatedAreaOf('/isolated/p/x'), null);
  });
});

test('openIsolatedPath: a plain file is opened, symlinks anywhere on the way are refused', async () => {
  await withRoot(async ({ root, project, secret }) => {
    fs.mkdirSync(path.join(project, 'sub'));
    fs.writeFileSync(path.join(project, 'sub', 'ok.txt'), 'ok');
    const fd = openIsolatedPath(root, path.join('p', 'sub', 'ok.txt'), 'read');
    assert.equal(fs.readFileSync(fd, 'utf8'), 'ok');
    fs.closeSync(fd);

    fs.symlinkSync(secret, path.join(project, 'link.txt'));
    assert.throws(() => openIsolatedPath(root, path.join('p', 'link.txt'), 'read'), IsolatedPathRefusedError);
    fs.symlinkSync(path.dirname(secret), path.join(project, 'linkdir'));
    assert.throws(() => openIsolatedPath(root, path.join('p', 'linkdir', 'secret.txt'), 'read'), IsolatedPathRefusedError);
    assert.throws(() => openIsolatedPath(root, path.join('p', 'linkdir'), 'dir'), IsolatedPathRefusedError);
    assert.throws(() => openIsolatedPath(root, ['p', '..', 'p', 'x'].join(path.sep), 'read'), IsolatedPathRefusedError);
    assert.throws(() => openIsolatedPath(root, path.join('p', 'missing.txt'), 'read'), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  });
});

test('openIsolatedPath: a FIFO is refused at once, for reading and for writing', async () => {
  await withRoot(async ({ root, project }) => {
    const fifo = path.join(project, 'pipe');
    execFileSync('mkfifo', [fifo]);
    await within(Promise.resolve().then(() => {
      assert.throws(() => openIsolatedPath(root, path.join('p', 'pipe'), 'read'), IsolatedPathRefusedError);
      assert.throws(() => openIsolatedPath(root, path.join('p', 'pipe'), 'write'), IsolatedPathRefusedError);
    }));
    await within(assert.rejects(isolatedFs.readText(fifo, 1024), IsolatedPathRefusedError));
  });
});

test('isolatedFs: writes never go through a symlink, reads are capped', async () => {
  await withRoot(async ({ project, secret }) => {
    fs.symlinkSync(secret, path.join(project, 'evil.txt'));
    await assert.rejects(isolatedFs.writeText(path.join(project, 'evil.txt'), 'pwned'), IsolatedPathRefusedError);
    assert.equal(fs.readFileSync(secret, 'utf8'), 'main secret');

    await isolatedFs.writeText(path.join(project, 'new.txt'), 'hello');
    assert.equal(fs.readFileSync(path.join(project, 'new.txt'), 'utf8'), 'hello');
    assert.equal((await isolatedFs.readText(path.join(project, 'new.txt'), 1024)).toString(), 'hello');
    await assert.rejects(isolatedFs.readText(path.join(project, 'new.txt'), 3), /too large/i);

    // mkdir -p through a symlinked component is refused, the target stays untouched.
    fs.symlinkSync(path.dirname(secret), path.join(project, 'out'));
    await assert.rejects(isolatedFs.makeDirectory(path.join(project, 'out', 'x'), true), IsolatedPathRefusedError);
    assert.equal(fs.existsSync(path.join(path.dirname(secret), 'x')), false);
    assert.equal(await isolatedFs.makeDirectory(path.join(project, 'd1', 'd2'), true), path.join(project, 'd1'));
    assert.ok(fs.statSync(path.join(project, 'd1', 'd2')).isDirectory());
  });
});

test('isolatedFs: lstat never follows, rename/unlink/removeTree act on the link itself', async () => {
  await withRoot(async ({ dir, project, secret }) => {
    const link = path.join(project, 'evil');
    fs.symlinkSync(path.dirname(secret), link);
    assert.equal((await isolatedFs.lstat(link)).isSymbolicLink(), true);

    fs.mkdirSync(path.join(project, 'tree', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(project, 'tree', 'deep', 'f.txt'), 'x');
    fs.symlinkSync(dir, path.join(project, 'tree', 'deep', 'up'));
    await isolatedFs.removeTree(path.join(project, 'tree'));
    assert.equal(fs.existsSync(path.join(project, 'tree')), false);
    assert.equal(fs.readFileSync(secret, 'utf8'), 'main secret');

    await isolatedFs.rename(link, path.join(project, 'renamed'));
    assert.equal(fs.lstatSync(path.join(project, 'renamed')).isSymbolicLink(), true);
    await isolatedFs.unlink(path.join(project, 'renamed'));
    assert.equal(fs.existsSync(path.join(project, 'renamed')), false);
    assert.equal(fs.existsSync(secret), true);

    const names: string[] = [];
    fs.writeFileSync(path.join(project, 'a.txt'), 'a');
    for await (const entry of isolatedFs.listDirectory(project)) names.push(entry.name);
    assert.deepEqual(names, ['a.txt']);
    // A directory swapped for a symlink is not listed through.
    fs.symlinkSync(dir, path.join(project, 'listme'));
    await assert.rejects(async () => {
      for await (const entry of isolatedFs.listDirectory(path.join(project, 'listme'))) names.push(entry.name);
    }, IsolatedPathRefusedError);
  });
});

test('without the isolation env: the isolated project and its home stay isolated, a sibling project does not', async () => {
  await withIsolatedDatabase(async (dir) => {
    const env = isolationEnvFor(dir);
    const isolated = path.join(env.CLOUDCLI_ISOLATED_ROOT, 'a');
    const sibling = path.join(env.CLOUDCLI_ISOLATED_ROOT, 'b');
    fs.mkdirSync(isolated, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    const projectId = projectsDb.createProjectPath(isolated, 'a').project!.project_id;
    projectsDb.createProjectPath(sibling, 'b');
    const transcripts = path.join(env.CLOUDCLI_ISOLATED_HOMES, projectId, '.claude', 'projects', 'enc');
    fs.mkdirSync(transcripts, { recursive: true });
    const fifo = path.join(transcripts, 's.jsonl');
    execFileSync('mkfifo', [fifo]);
    await withIsolationEnv(env, () => {
      isolationDb.markIsolated(projectId, 20001);
      sessionsDb.createSession('s1', 'claude', isolated, 'chat', undefined, undefined, fifo);
    });
    await withIsolationEnv(null, async () => {
      await new Promise((resolve) => setTimeout(resolve, 2100)); // past the roots cache of earlier tests
      assert.deepEqual(isolatedAreaOf(path.join(isolated, 'x')), { root: isolated, rel: 'x' });
      assert.equal(isolatedAreaOf(path.join(sibling, 'x')), null);
      assert.equal(isolatedAreaOf(fifo)?.root, path.join(env.CLOUDCLI_ISOLATED_HOMES, projectId));
      await within(assert.rejects(readTranscriptText(fifo)));
      await within(assert.rejects(isolatedFs.readText(fifo, 1024), IsolatedPathRefusedError));
    });
  });
});

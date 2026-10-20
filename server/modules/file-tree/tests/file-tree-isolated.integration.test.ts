// The Files tab on an isolated project: the agent owns the tree and can plant symlinks (to app secrets) and FIFOs.
// Reads, writes and the ZIP download must neither follow them out of the project nor block on them.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { fileTreeRoutes } from '@/modules/file-tree/index.js';
import { isolationDb } from '@/modules/isolation/index.js';

const ISOLATION_ENV = ['CLOUDCLI_ISOLATED_ROOT', 'CLOUDCLI_ISOLATED_HOMES', 'CLOUDCLI_ISOLATION_DIR', 'CLOUDCLI_SANDBOX_DAEMON_TOKEN'] as const;
const SECRET = 'MAIN-APP-SECRET';

type Ctx = { dir: string; base: string; isolated: { id: string; root: string }; plain: { id: string; root: string }; secret: string };

async function withFiles(run: (ctx: Ctx) => Promise<void>) {
  const dir = fs.realpathSync(await mkdtemp(path.join(os.tmpdir(), 'ft-iso-')));
  const previous = { db: process.env.DATABASE_PATH, ...Object.fromEntries(ISOLATION_ENV.map((key) => [key, process.env[key]])) } as Record<string, string | undefined>;
  const env: Record<string, string> = {
    CLOUDCLI_ISOLATED_ROOT: path.join(dir, 'isolated'),
    CLOUDCLI_ISOLATED_HOMES: path.join(dir, 'homes'),
    CLOUDCLI_ISOLATION_DIR: path.join(dir, 'iso'),
    CLOUDCLI_SANDBOX_DAEMON_TOKEN: 't',
  };
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
    if (key !== 'CLOUDCLI_SANDBOX_DAEMON_TOKEN') fs.mkdirSync(value, { recursive: true });
  }
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();

  const secret = path.join(dir, 'secret.txt');
  fs.writeFileSync(secret, SECRET);
  const isolatedRoot = path.join(env.CLOUDCLI_ISOLATED_ROOT, 'agent');
  fs.mkdirSync(isolatedRoot);
  const isolatedId = projectsDb.createProjectPath(isolatedRoot, 'agent').project!.project_id;
  isolationDb.markIsolated(isolatedId, 20001);
  const plainRoot = path.join(dir, 'workspace', 'plain');
  fs.mkdirSync(plainRoot, { recursive: true });
  const plainId = projectsDb.createProjectPath(plainRoot, 'plain').project!.project_id;

  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    (request as express.Request & { user?: unknown }).user = { id: 1, username: 'admin', role: 'admin' };
    next();
  });
  app.use('/api/file-tree', fileTreeRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const warn = console.warn;
  console.warn = () => undefined; // adopt() without a daemon
  try {
    await run({
      dir,
      base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/file-tree/projects`,
      isolated: { id: isolatedId, root: isolatedRoot },
      plain: { id: plainId, root: plainRoot },
      secret,
    });
  } finally {
    console.warn = warn;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    for (const key of ISOLATION_ENV) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    if (previous.db === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous.db;
    await rm(dir, { recursive: true, force: true });
  }
}

/** Rejects instead of hanging when a request does not answer quickly (a FIFO that blocks the server). */
async function quickly(url: string, init?: RequestInit, ms = 3000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

const json = (body: unknown, method = 'PUT'): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('isolated project: preview and download refuse symlinks out and FIFOs, plain files still open', async () => {
  await withFiles(async ({ base, isolated, secret }) => {
    fs.writeFileSync(path.join(isolated.root, 'ok.txt'), 'hello');
    fs.symlinkSync(secret, path.join(isolated.root, 'link.txt'));
    fs.symlinkSync(path.dirname(secret), path.join(isolated.root, 'up'));
    execFileSync('mkfifo', [path.join(isolated.root, 'pipe.txt')]);

    const ok = await quickly(`${base}/${isolated.id}/file?filePath=ok.txt`);
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { content: string }).content, 'hello');

    for (const rel of ['link.txt', path.join('up', 'secret.txt'), 'pipe.txt']) {
      const preview = await quickly(`${base}/${isolated.id}/file?filePath=${encodeURIComponent(rel)}`);
      assert.equal(preview.status, 403, rel);
      assert.doesNotMatch(await preview.text(), new RegExp(SECRET));
      const download = await quickly(`${base}/${isolated.id}/files/content?path=${encodeURIComponent(rel)}`);
      assert.notEqual(download.status, 200, rel);
      assert.doesNotMatch(await download.text(), new RegExp(SECRET));
    }
    const content = await quickly(`${base}/${isolated.id}/files/content?path=ok.txt`);
    assert.equal(await content.text(), 'hello');
  });
});

test('isolated project: listing shows symlinks as links and never expands them', async () => {
  await withFiles(async ({ base, isolated, secret }) => {
    fs.mkdirSync(path.join(isolated.root, 'src'));
    fs.writeFileSync(path.join(isolated.root, 'src', 'a.js'), '1');
    fs.symlinkSync(path.dirname(secret), path.join(isolated.root, 'up'));
    const response = await quickly(`${base}/${isolated.id}/files`);
    assert.equal(response.status, 200);
    const tree = await response.json() as Array<{ name: string; isSymlink?: boolean; children?: unknown[] }>;
    const up = tree.find((node) => node.name === 'up');
    assert.equal(up?.isSymlink, true);
    assert.equal(up?.children, undefined);
    assert.ok(tree.find((node) => node.name === 'src')?.children?.length === 1);
    assert.doesNotMatch(JSON.stringify(tree), /secret\.txt/);
  });
});

test('isolated project: save, create, rename, delete and upload never act through a symlink', async () => {
  await withFiles(async ({ dir, base, isolated, secret }) => {
    fs.symlinkSync(secret, path.join(isolated.root, 'link.txt'));
    fs.symlinkSync(path.dirname(secret), path.join(isolated.root, 'up'));

    const save = await quickly(`${base}/${isolated.id}/file`, json({ filePath: 'link.txt', content: 'pwned' }));
    assert.equal(save.status, 403);
    const saveThroughDir = await quickly(`${base}/${isolated.id}/file`, json({ filePath: path.join('up', 'secret.txt'), content: 'pwned' }));
    assert.equal(saveThroughDir.status, 403);
    const create = await quickly(`${base}/${isolated.id}/files/create`, json({ path: 'up', name: 'planted.txt', type: 'file' }, 'POST'));
    assert.notEqual(create.status, 200);
    assert.equal(fs.existsSync(path.join(dir, 'planted.txt')), false);
    const rename = await quickly(`${base}/${isolated.id}/files/rename`, json({ oldPath: path.join('up', 'secret.txt'), newName: 'moved.txt' }));
    assert.notEqual(rename.status, 200);
    assert.equal(fs.readFileSync(secret, 'utf8'), SECRET);

    const form = new FormData();
    form.append('targetPath', 'up');
    form.append('files', new Blob(['uploaded']), 'dropped.txt');
    const upload = await quickly(`${base}/${isolated.id}/files/upload`, { method: 'POST', body: form });
    assert.notEqual(upload.status, 200);
    assert.equal(fs.existsSync(path.join(dir, 'dropped.txt')), false);

    // Deleting the link removes the link, never what it points to.
    const remove = await quickly(`${base}/${isolated.id}/files`, json({ path: 'up' }, 'DELETE'));
    assert.equal(remove.status, 200);
    assert.equal(fs.existsSync(path.join(isolated.root, 'up')), false);
    assert.equal(fs.readFileSync(secret, 'utf8'), SECRET);

    // Plain writes still work.
    const good = await quickly(`${base}/${isolated.id}/file`, json({ filePath: 'notes.txt', content: 'fine' }));
    assert.equal(good.status, 200);
    assert.equal(fs.readFileSync(path.join(isolated.root, 'notes.txt'), 'utf8'), 'fine');
    const folder = await quickly(`${base}/${isolated.id}/files/create`, json({ path: '', name: 'docs', type: 'directory' }, 'POST'));
    assert.equal(folder.status, 200);
    assert.ok(fs.statSync(path.join(isolated.root, 'docs')).isDirectory());
  });
});

test('isolated project: the ZIP skips symlinks and special files', async () => {
  await withFiles(async ({ base, isolated, secret }) => {
    fs.writeFileSync(path.join(isolated.root, 'keep.txt'), 'kept');
    fs.mkdirSync(path.join(isolated.root, 'sub'));
    fs.writeFileSync(path.join(isolated.root, 'sub', 'inner.txt'), 'inner');
    fs.symlinkSync(secret, path.join(isolated.root, 'link.txt'));
    fs.symlinkSync(path.dirname(secret), path.join(isolated.root, 'up'));
    execFileSync('mkfifo', [path.join(isolated.root, 'pipe')]);
    const response = await quickly(`${base}/${isolated.id}/archive`);
    assert.equal(response.status, 200);
    const zip = Buffer.from(await response.arrayBuffer()).toString('latin1');
    assert.ok(zip.startsWith('PK'));
    assert.ok(zip.includes('keep.txt'));
    assert.ok(zip.includes('sub/inner.txt'));
    for (const skipped of ['link.txt', 'up', 'pipe', 'secret.txt']) assert.ok(!zip.includes(skipped), `${skipped} in the ZIP`);
  });
});

test('a project that is not isolated behaves as before', async () => {
  await withFiles(async ({ base, plain, secret }) => {
    fs.symlinkSync(secret, path.join(plain.root, 'link.txt'));
    const preview = await quickly(`${base}/${plain.id}/file?filePath=link.txt`);
    assert.equal(preview.status, 200);
    assert.equal(((await preview.json()) as { content: string }).content, SECRET);
    const save = await quickly(`${base}/${plain.id}/file`, json({ filePath: 'a.txt', content: 'x' }));
    assert.equal(save.status, 200);
    const response = await quickly(`${base}/${plain.id}/archive`);
    assert.ok(Buffer.from(await response.arrayBuffer()).toString('latin1').includes('a.txt'));
  });
});

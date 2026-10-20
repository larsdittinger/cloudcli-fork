import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { connectSpawn } from '../daemon/client.js';
import { startDaemon, type RunningDaemon } from '../daemon/daemon.js';
import { FrameDecoder, type Frame } from '../daemon/frames.js';
import { adoptPaths } from '../daemon/projects.js';
import type { SpawnRequest } from '../daemon/process-host.js';

const TOKEN = 'adopt-token';
const UID = 20011;
let tmp: string;
let root: string;
let homes: string;
let daemon: RunningDaemon;

function call(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: daemon.socketPath, method, path: urlPath, headers: { Authorization: `Bearer ${TOKEN}` } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbxa-')));
  root = path.join(tmp, 'isolated');
  homes = path.join(tmp, 'homes');
  fs.mkdirSync(path.join(root, 'proj'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'outside'));
  daemon = await startDaemon({
    token: TOKEN,
    isolationDir: path.join(tmp, 'iso'),
    dev: true,
    isolatedRoot: root,
    isolatedHomes: homes,
    statOwner: () => UID,
  });
  const put = await call('PUT', '/v1/projects/proj', { uid: UID, name: 'P', allowlist: [], proxySecret: 's' });
  assert.equal(put.status, 200);
});

after(async () => {
  await daemon.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const projectDir = () => path.join(root, 'proj');

test('adopt fixes modes of the listed paths and every directory on the way', async () => {
  const dir = path.join(projectDir(), '.cloudcli-attachments', 'msg-1');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(projectDir(), '.cloudcli-attachments'), 0o700);
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, 'a.pdf'), 'x', { mode: 0o600 });
  fs.chmodSync(path.join(dir, 'a.pdf'), 0o600);
  // Something else in the project is not touched (no whole-tree walk).
  fs.writeFileSync(path.join(projectDir(), 'other.txt'), 'y');
  fs.chmodSync(path.join(projectDir(), 'other.txt'), 0o600);

  const res = await call('POST', '/v1/projects/proj/adopt', { uid: UID, projectDir: projectDir(), paths: ['.cloudcli-attachments/msg-1'] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(fs.statSync(path.join(projectDir(), '.cloudcli-attachments')).mode & 0o7777, 0o2770);
  assert.equal(fs.statSync(dir).mode & 0o7777, 0o2770);
  assert.equal(fs.statSync(path.join(dir, 'a.pdf')).mode & 0o060, 0o060);
  assert.equal(fs.statSync(path.join(projectDir(), 'other.txt')).mode & 0o7777, 0o600);
});

test('adopt rejects bad paths, uid mismatch and unknown projects', async () => {
  const status = async (body: Record<string, unknown>, project = 'proj') =>
    (await call('POST', `/v1/projects/${project}/adopt`, { uid: UID, projectDir: projectDir(), ...body })).status;
  assert.equal(await status({ paths: ['../outside'] }), 400);
  assert.equal(await status({ paths: ['/etc'] }), 400);
  assert.equal(await status({ paths: ['a/../../x'] }), 400);
  assert.equal(await status({ paths: [''] }), 400);
  assert.equal(await status({ paths: 'x' }), 400);
  assert.equal(await status({ paths: ['x'], projectDir: tmp }), 400);
  assert.equal(await status({ paths: ['x'], uid: 20099 }), 409);
  assert.equal(await status({ paths: ['x'], uid: 5 }), 400);
  assert.equal(await status({ paths: ['x'] }, 'ghost'), 409);
});

test('adopt never follows a symlink, neither on the way nor at the end', async () => {
  const target = path.join(tmp, 'outside', 'secret');
  fs.writeFileSync(target, 's');
  fs.chmodSync(target, 0o600);
  fs.chmodSync(path.join(tmp, 'outside'), 0o700);
  fs.symlinkSync(path.join(tmp, 'outside'), path.join(projectDir(), 'via'));
  fs.symlinkSync(target, path.join(projectDir(), 'leaf'));

  const via = await call('POST', '/v1/projects/proj/adopt', { uid: UID, projectDir: projectDir(), paths: ['via/secret'] });
  assert.equal(via.status, 400);
  assert.match(via.body.error, /symlink/);
  const leaf = await call('POST', '/v1/projects/proj/adopt', { uid: UID, projectDir: projectDir(), paths: ['leaf'] });
  assert.equal(leaf.status, 400);
  assert.equal(fs.statSync(target).mode & 0o7777, 0o600);
  assert.equal(fs.statSync(path.join(tmp, 'outside')).mode & 0o7777, 0o700);
});

test('adoptPaths fails closed in production without /proc/self/fd', () => {
  assert.throws(
    () => adoptPaths({ projectId: 'proj', uid: UID, projectDir: projectDir(), paths: ['x'] },
      { isolatedRoot: root, isolatedHomes: homes, statOwner: () => UID, dev: false, mainGid: 1, procFd: false }),
    /proc/,
  );
});

test('a spawn whose args total more than 64 KiB is accepted (big X-Spawn header)', async () => {
  const big = 'x'.repeat(70 * 1024);
  const request: SpawnRequest = {
    kind: 'exec',
    projectId: 'proj',
    uid: UID,
    projectDir: projectDir(),
    homeDir: path.join(homes, 'proj'),
    // exec runs `bash -lc args[0]`; the long second argument only makes the header big.
    args: [`echo ${big.length}`, big],
    env: {},
    cwd: projectDir(),
  };
  const socket = await connectSpawn(daemon.socketPath, TOKEN, request);
  const decoder = new FrameDecoder();
  const frames: Frame[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 10_000);
    socket.on('data', (chunk: Buffer) => frames.push(...decoder.push(chunk)));
    socket.on('close', () => { clearTimeout(timer); resolve(); });
  });
  const out = Buffer.concat(frames.filter((f) => f.type === 'stdout').map((f) => f.payload)).toString().trim();
  assert.equal(out, String(big.length));
});

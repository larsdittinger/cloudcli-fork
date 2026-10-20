import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { PassThrough, type Duplex } from 'node:stream';

import { connectSpawn } from '../daemon/client.js';
import { startDaemon, type RunningDaemon } from '../daemon/daemon.js';
import { FrameDecoder, type Frame } from '../daemon/frames.js';
import { hostProcess, type SpawnRequest } from '../daemon/process-host.js';
import { prepareProject } from '../daemon/projects.js';

const TOKEN = 'test-token';
const UID = 20001;
let tmp: string;
let root: string;
let homes: string;
let daemon: RunningDaemon;
let ownerUid = UID;
const selfCheckEnvs: Array<Record<string, string>> = [];

function call(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: daemon.socketPath, method, path: urlPath, headers: { Authorization: `Bearer ${TOKEN}` } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function collect(socket: Duplex): Promise<Frame[]> {
  const decoder = new FrameDecoder();
  const frames: Frame[] = [];
  return new Promise((resolve) => {
    socket.on('data', (chunk: Buffer) => frames.push(...decoder.push(chunk)));
    socket.on('close', () => resolve(frames));
  });
}
const text = (frames: Frame[], type: string) => Buffer.concat(frames.filter((f) => f.type === type).map((f) => f.payload)).toString();

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbxp-')));
  root = path.join(tmp, 'isolated');
  homes = path.join(tmp, 'homes');
  fs.mkdirSync(path.join(root, 'proj'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'outside'));
  fs.symlinkSync(tmp, path.join(root, 'proj', 'escape'));
  daemon = await startDaemon({
    token: TOKEN,
    isolationDir: path.join(tmp, 'iso'),
    dev: true,
    isolatedRoot: root,
    isolatedHomes: homes,
    statOwner: () => ownerUid,
    selfCheckRunner: async (ctx) => {
      selfCheckEnvs.push(ctx.request.env);
      return { checks: [{ id: 'no-workspace', ok: true, detail: `uid ${ctx.request.uid} token ${ctx.runToken}` }] };
    },
  });
  const put = await call('PUT', '/v1/projects/proj', { uid: UID, name: 'P', allowlist: ['example.org'], proxySecret: 's3' });
  assert.equal(put.status, 200);
});

after(async () => {
  await daemon.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function request(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    kind: 'exec',
    projectId: 'proj',
    uid: UID,
    projectDir: path.join(root, 'proj'),
    homeDir: path.join(homes, 'proj'),
    args: ['pwd'],
    env: {},
    cwd: path.join(root, 'proj'),
    ...overrides,
  };
}

async function rejected(overrides: Partial<SpawnRequest>, pattern: RegExp) {
  const marker = path.join(tmp, 'ran');
  const frames = await collect(await connectSpawn(daemon.socketPath, TOKEN, request({ args: [`touch ${marker}`], ...overrides })));
  assert.match(text(frames, 'error'), pattern);
  assert.match(text(frames, 'error'), /^Rejected: /);
  assert.equal(frames.some((f) => f.type === 'exit'), false);
  assert.equal(fs.existsSync(marker), false);
}

test('accepts a valid spawn inside the project', async () => {
  fs.mkdirSync(path.join(root, 'proj', 'sub'), { recursive: true });
  const frames = await collect(await connectSpawn(daemon.socketPath, TOKEN, request({ cwd: path.join(root, 'proj', 'sub') })));
  assert.equal(text(frames, 'stdout').trim(), path.join(root, 'proj', 'sub'));
});

test('rejects cwd outside root', async () => {
  await rejected({ cwd: path.join(tmp, 'outside') }, /cwd/);
  await rejected({ cwd: `${path.join(root, 'proj')}/../../outside` }, /cwd/);
  await rejected({ cwd: path.join(root, 'proj-evil') }, /cwd/);
});

test('rejects symlink escape', async () => {
  await rejected({ cwd: path.join(root, 'proj', 'escape') }, /cwd/);
});

test('rejects projectDir that is not a direct child of the root', async () => {
  await rejected({ projectDir: tmp, cwd: tmp }, /projectDir/);
  await rejected({ projectDir: path.join(root, 'proj', 'sub'), cwd: path.join(root, 'proj', 'sub') }, /projectDir/);
});

test('rejects uid mismatch', async () => {
  ownerUid = 20009;
  try {
    await rejected({}, /owner|uid/);
  } finally {
    ownerUid = UID;
  }
  await rejected({ uid: 20002 }, /uid/); // not the uid pushed for this project
  await rejected({ uid: 100 }, /uid/);
});

test('rejects unknown project and wrong homeDir', async () => {
  await rejected({ projectId: 'ghost' }, /project/);
  await rejected({ homeDir: path.join(homes, 'other') }, /homeDir/);
  await rejected({ homeDir: path.join(homes, 'proj', '..') }, /homeDir/);
});

test('prepare writes .claude.json and keeps keys', async () => {
  const projectDir = path.join(root, 'proj');
  const homeDir = path.join(homes, 'proj');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({ theme: 'dark', projects: { '/else': { x: 1 } } }));
  fs.writeFileSync(path.join(projectDir, 'file.txt'), 'x');
  fs.chmodSync(path.join(projectDir, 'file.txt'), 0o600);
  fs.symlinkSync('/etc/hostname', path.join(projectDir, 'link'));
  const target = path.join(tmp, 'outside', 'target');
  fs.writeFileSync(target, 'y');
  fs.chmodSync(target, 0o600);
  fs.symlinkSync(target, path.join(projectDir, 'to-outside'));

  const res = await call('POST', '/v1/projects/proj/prepare', { uid: UID, projectDir, homeDir });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const json = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf8'));
  assert.equal(json.theme, 'dark');
  assert.equal(json.hasCompletedOnboarding, true);
  assert.deepEqual(json.projects['/else'], { x: 1 });
  assert.equal(json.projects[projectDir].hasTrustDialogAccepted, true);

  assert.equal(fs.statSync(projectDir).mode & 0o7777, 0o2770);
  assert.equal(fs.statSync(path.join(projectDir, 'sub')).mode & 0o7777, 0o2770);
  assert.equal(fs.statSync(path.join(projectDir, 'file.txt')).mode & 0o060, 0o060);
  // chmod never goes through a symlink
  assert.equal(fs.statSync(target).mode & 0o7777, 0o600);
  // second run is idempotent
  assert.equal((await call('POST', '/v1/projects/proj/prepare', { uid: UID, projectDir, homeDir })).status, 200);
});

test('prepare rejects bad paths and uids', async () => {
  const bad = async (body: object) => (await call('POST', '/v1/projects/proj/prepare', body)).status;
  assert.equal(await bad({ uid: UID, projectDir: tmp, homeDir: path.join(homes, 'proj') }), 400);
  assert.equal(await bad({ uid: UID, projectDir: path.join(root, 'proj'), homeDir: path.join(homes, 'x') }), 400);
  assert.equal(await bad({ uid: 5, projectDir: path.join(root, 'proj'), homeDir: path.join(homes, 'proj') }), 400);
  assert.equal(await bad({ uid: 20002, projectDir: path.join(root, 'proj'), homeDir: path.join(homes, 'proj') }), 409);
  const symlinked = path.join(root, 'sym');
  fs.symlinkSync(path.join(tmp, 'outside'), symlinked);
  await call('PUT', '/v1/projects/sym', { uid: 20003, name: 'S', allowlist: [], proxySecret: 'a' });
  assert.equal(
    (await call('POST', '/v1/projects/sym/prepare', { uid: 20003, projectDir: symlinked, homeDir: path.join(homes, 'sym') })).status,
    400,
  );
});

test('self-check runs the runner as the project uid with the run token', async () => {
  const res = await call('POST', '/v1/projects/proj/self-check', { runToken: 'tok-1', projectDir: path.join(root, 'proj') });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { checks: [{ id: 'no-workspace', ok: true, detail: `uid ${UID} token tok-1` }] });
  // The probe runs with the project's own TMPDIR, like every other process of the project.
  assert.equal(selfCheckEnvs.at(-1)!.TMPDIR, path.join(homes, 'proj', '.tmp'));
  assert.equal(selfCheckEnvs.at(-1)!.CLAUDE_CODE_TMPDIR, path.join(homes, 'proj', '.tmp'));
  assert.equal((await call('POST', '/v1/projects/proj/self-check', { projectDir: path.join(root, 'proj') })).status, 400);
  assert.equal((await call('POST', '/v1/projects/ghost/self-check', { runToken: 'a', projectDir: root })).status, 404);
});

test('status reports version, claude version and project count', async () => {
  const res = await call('GET', '/v1/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.version, 'string');
  assert.equal(typeof res.body.claudeVersion, 'string');
  assert.ok(res.body.projects >= 1);
});

test('spawns in the validated projectDir and enters the subdir only after the drop', async () => {
  const sub = path.join(root, 'proj', 'sub');
  fs.mkdirSync(sub, { recursive: true });
  const frames = await collect(await connectSpawn(daemon.socketPath, TOKEN, request({ cwd: sub, args: ['pwd -P'] })));
  assert.equal(text(frames, 'stdout').trim(), fs.realpathSync(sub));
  const bad = await collect(await connectSpawn(daemon.socketPath, TOKEN, request({ cwd: sub, args: ['exit 0'] })));
  assert.equal(JSON.parse(bad.find((f) => f.type === 'exit')!.payload.toString()).code, 0);

  // The process is created with the (root-owned parent) projectDir as cwd, never with the swappable subdir.
  let seen: { cwd?: unknown; command?: string; args?: string[] } = {};
  const fakeChild = Object.assign(new PassThrough(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 0, kill: () => true });
  const sock = new PassThrough();
  hostProcess(sock, request({ cwd: sub }), {
    dev: true, claudeBin: 'claude',
    spawnImpl: ((command: string, args: string[], o: { cwd?: unknown }) => { seen = { cwd: o.cwd, command, args }; return fakeChild; }) as never,
  });
  assert.equal(seen.cwd, path.join(root, 'proj'));
  assert.ok(seen.args!.includes(sub));
  sock.destroy();
});

test('prepare tolerates a FIFO as .claude.json', async () => {
  const projectDir = path.join(root, 'proj');
  const homeDir = path.join(homes, 'proj');
  fs.rmSync(path.join(homeDir, '.claude.json'), { force: true });
  execFileSync('mkfifo', [path.join(homeDir, '.claude.json')]);
  const res = await call('POST', '/v1/projects/proj/prepare', { uid: UID, projectDir, homeDir });
  assert.equal(res.status, 200);
  assert.ok(res.body.warnings.some((w: string) => /claude\.json/.test(w)));
  assert.equal(fs.statSync(path.join(homeDir, '.claude.json')).isFile(), true);
});

test('prepare fails closed in production without /proc/self/fd', () => {
  const marker = path.join(root, 'proj', 'untouched');
  fs.writeFileSync(marker, 'x');
  fs.chmodSync(marker, 0o600);
  assert.throws(
    () => prepareProject({ projectId: 'proj', uid: UID, projectDir: path.join(root, 'proj'), homeDir: path.join(homes, 'proj') },
      { isolatedRoot: root, isolatedHomes: homes, statOwner: () => UID, dev: false, mainGid: 1, procFd: false }),
    /proc/,
  );
  assert.equal(fs.statSync(marker).mode & 0o7777, 0o600);
});

test('prepare requires a project that was pushed', async () => {
  const body = { uid: 20077, projectDir: path.join(root, 'proj'), homeDir: path.join(homes, 'ghost') };
  assert.equal((await call('POST', '/v1/projects/ghost/prepare', body)).status, 409);
});

test('prepare gives the project a private temp dir in its home; a planted symlink there is replaced, not followed', async () => {
  const projectDir = path.join(root, 'proj');
  const homeDir = path.join(homes, 'proj');
  fs.mkdirSync(homeDir, { recursive: true });
  const target = path.join(tmp, 'outside', 'tmp-target');
  fs.mkdirSync(target, { recursive: true });
  fs.chmodSync(target, 0o755);
  fs.rmSync(path.join(homeDir, '.tmp'), { recursive: true, force: true });
  fs.symlinkSync(target, path.join(homeDir, '.tmp'));

  const res = await call('POST', '/v1/projects/proj/prepare', { uid: UID, projectDir, homeDir });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const st = fs.lstatSync(path.join(homeDir, '.tmp'));
  assert.equal(st.isDirectory(), true);
  assert.equal(st.mode & 0o7777, 0o700);
  assert.equal(fs.statSync(target).mode & 0o7777, 0o755);

  // A file in its place is replaced too; an existing directory is kept with its content.
  fs.rmSync(path.join(homeDir, '.tmp'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.tmp'), 'x');
  assert.equal((await call('POST', '/v1/projects/proj/prepare', { uid: UID, projectDir, homeDir })).status, 200);
  assert.equal(fs.lstatSync(path.join(homeDir, '.tmp')).isDirectory(), true);
  fs.writeFileSync(path.join(homeDir, '.tmp', 'keep'), 'k');
  assert.equal((await call('POST', '/v1/projects/proj/prepare', { uid: UID, projectDir, homeDir })).status, 200);
  assert.equal(fs.readFileSync(path.join(homeDir, '.tmp', 'keep'), 'utf8'), 'k');
  assert.equal(fs.statSync(path.join(homeDir, '.tmp')).mode & 0o7777, 0o700);
});

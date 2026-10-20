import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { PassThrough, type Duplex } from 'node:stream';

import { connectSpawn, DaemonRejectedError } from '../daemon/client.js';
import { startDaemon, type RunningDaemon } from '../daemon/daemon.js';
import { FrameDecoder, encodeFrame, type Frame } from '../daemon/frames.js';
import { hostProcess, type SpawnRequest } from '../daemon/process-host.js';

const TOKEN = 'test-token';
let tmp: string;
let daemon: RunningDaemon;

/** Dev daemon whose isolated root is <dir>/isolated and which knows project p1 (uid 20001). */
async function devDaemon(dir: string): Promise<RunningDaemon> {
  fs.mkdirSync(path.join(dir, 'isolated', 'p1'), { recursive: true });
  const d = await startDaemon({
    token: TOKEN, isolationDir: dir, dev: true,
    isolatedRoot: path.join(dir, 'isolated'), isolatedHomes: path.join(dir, 'homes'), statOwner: () => 20001,
  });
  const body = JSON.stringify({ uid: 20001, name: 'P', allowlist: [], proxySecret: 's' });
  await new Promise<void>((resolve, reject) => {
    const req = http.request({ socketPath: d.socketPath, method: 'PUT', path: '/v1/projects/p1', headers: { Authorization: `Bearer ${TOKEN}` } }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.end(body);
  });
  return d;
}

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-')));
  daemon = await devDaemon(tmp);
});

after(async () => {
  await daemon.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function request(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    kind: 'exec',
    projectId: 'p1',
    uid: 20001,
    projectDir: path.join(tmp, 'isolated', 'p1'),
    homeDir: path.join(tmp, 'homes', 'p1'),
    args: ['true'],
    env: {},
    cwd: path.join(tmp, 'isolated', 'p1'),
    ...overrides,
  };
}

function collect(socket: Duplex): Promise<Frame[]> {
  const decoder = new FrameDecoder();
  const frames: Frame[] = [];
  return new Promise((resolve) => {
    socket.on('data', (chunk: Buffer) => frames.push(...decoder.push(chunk)));
    socket.on('close', () => resolve(frames));
  });
}

const text = (frames: Frame[], type: string) =>
  Buffer.concat(frames.filter((f) => f.type === type).map((f) => f.payload)).toString();
const exitOf = (frames: Frame[]) => JSON.parse(frames.find((f) => f.type === 'exit')!.payload.toString());

test('echo over stdin', async () => {
  const socket = await connectSpawn(daemon.socketPath, TOKEN, request({ args: ['cat'] }));
  const done = collect(socket);
  socket.write(encodeFrame('stdin', 'over stdin'));
  socket.write(encodeFrame('stdin_end', ''));
  const frames = await done;
  assert.equal(text(frames, 'stdout'), 'over stdin');
  assert.equal(exitOf(frames).code, 0);
});

test('exit code propagated', async () => {
  const socket = await connectSpawn(daemon.socketPath, TOKEN, request({ args: ['exit 3'] }));
  assert.equal(exitOf(await collect(socket)).code, 3);
});

test('kill sends signal', async () => {
  const socket = await connectSpawn(daemon.socketPath, TOKEN, request({ args: ['sleep 60'] }));
  const done = collect(socket);
  setTimeout(() => socket.write(encodeFrame('kill', 'SIGTERM')), 200);
  assert.equal(exitOf(await done).signal, 'SIGTERM');
});

test('rejects missing token', async () => {
  const marker = path.join(tmp, 'should-not-exist');
  await assert.rejects(
    connectSpawn(daemon.socketPath, '', request({ args: [`touch ${marker}`] })),
    (error: unknown) => error instanceof DaemonRejectedError && error.statusCode === 401,
  );
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fs.existsSync(marker), false);
});

test('env is exactly what was sent', async () => {
  const socket = await connectSpawn(
    daemon.socketPath,
    TOKEN,
    request({ args: ['env'], env: { FOO: 'bar', PATH: '/usr/bin:/bin' } }),
  );
  const frames = await collect(socket);
  const keys = text(frames, 'stdout')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('=')[0])
    // variables bash itself adds
    .filter((key) => !['PWD', 'OLDPWD', 'SHLVL', '_'].includes(key))
    .sort();
  assert.deepEqual(keys, ['FOO', 'HOME', 'PATH']);
});

test('exit on daemon disconnect', async () => {
  const pidFile = path.join(tmp, 'pid');
  const socket = await connectSpawn(
    daemon.socketPath,
    TOKEN,
    request({ args: [`echo $$ > ${pidFile}; exec sleep 60`] }),
  );
  for (let i = 0; i < 50 && !fs.existsSync(pidFile); i += 1) await new Promise((r) => setTimeout(r, 50));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);
  socket.destroy();
  const deadline = Date.now() + 2000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false);
});

test('pty runs a command with a terminal and propagates the exit code', async () => {
  const socket = await connectSpawn(daemon.socketPath, TOKEN, request({ kind: 'pty', args: ['test -t 0 && echo tty-yes; exit 4'] }));
  const frames = await collect(socket);
  assert.match(text(frames, 'stdout'), /tty-yes/);
  assert.equal(exitOf(frames).code, 4);
});

test('pty: stdin reaches the terminal, resize changes its size, env is the request env', async () => {
  const socket = await connectSpawn(
    daemon.socketPath, TOKEN,
    request({ kind: 'pty', args: ['read line; echo "got:$line:$FOO"; sleep 0.5; stty size; exit 0'], env: { FOO: 'bar', PATH: '/usr/bin:/bin' } }),
  );
  const done = collect(socket);
  socket.write(encodeFrame('resize', JSON.stringify({ cols: 101, rows: 33 })));
  setTimeout(() => socket.write(encodeFrame('stdin', 'hello\n')), 200);
  const frames = await done;
  assert.match(text(frames, 'stdout'), /got:hello:bar/);
  assert.match(text(frames, 'stdout'), /33 101/);
});

test('pty: cwd below the project is entered after the drop and kill ends it', async () => {
  fs.mkdirSync(path.join(tmp, 'isolated', 'p1', 'sub'), { recursive: true });
  const socket = await connectSpawn(
    daemon.socketPath, TOKEN,
    request({ kind: 'pty', args: ['pwd; sleep 60'], cwd: path.join(tmp, 'isolated', 'p1', 'sub') }),
  );
  const done = collect(socket);
  setTimeout(() => socket.write(encodeFrame('kill', 'SIGTERM')), 500);
  const frames = await done;
  assert.match(text(frames, 'stdout'), /isolated\/p1\/sub/);
  assert.equal(exitOf(frames).signal, 'SIGTERM');
});

test('pty without node-pty is reported as an error frame', async () => {
  const frames: Frame[] = [];
  const decoder = new FrameDecoder();
  const socket = Object.assign(new PassThrough(), {
    write: (chunk: Buffer) => {
      frames.push(...decoder.push(chunk));
      return true;
    },
    end: () => undefined,
  }) as unknown as Duplex;
  hostProcess(socket, request({ kind: 'pty' }), { dev: true, claudeBin: 'claude', loadPty: async () => { throw new Error('missing'); } });
  await new Promise((r) => setTimeout(r, 100));
  assert.match(text(frames, 'error'), /pty not supported/);
});

test('close() kills every live process group, grandchildren included', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-close-')));
  const local = await devDaemon(dir);
  const pidFile = path.join(dir, 'pids');
  await connectSpawn(
    local.socketPath,
    TOKEN,
    request({
      args: [`sleep 60 & echo $! > ${pidFile}; exec sleep 60`],
      projectDir: path.join(dir, 'isolated', 'p1'), homeDir: path.join(dir, 'homes', 'p1'), cwd: path.join(dir, 'isolated', 'p1'),
    }),
  );
  for (let i = 0; i < 50 && !fs.existsSync(pidFile); i += 1) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 100));
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(grandchild > 0);
  await local.close();
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 20 && isAlive(grandchild); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(isAlive(grandchild), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refuses to start outside dev mode without CLOUDCLI_MAIN_GID', async () => {
  await assert.rejects(
    startDaemon({ token: TOKEN, isolationDir: tmp, socketPath: path.join(tmp, 'nogid.sock') }),
    /CLOUDCLI_MAIN_GID/,
  );
});

test('production mode rejects uid below 20000 before spawning', async () => {
  const sent: Buffer[] = [];
  const fake = new PassThrough();
  fake.on('data', (c: Buffer) => sent.push(c));
  const marker = path.join(tmp, 'low-uid-ran');
  hostProcess(fake, request({ uid: 100, args: [`touch ${marker}`] }), { dev: false, claudeBin: 'claude' });
  await new Promise((r) => setTimeout(r, 100));
  const frames = new FrameDecoder().push(Buffer.concat(sent));
  assert.equal(frames[0].type, 'error');
  assert.match(frames[0].payload.toString(), /uid below isolated range/);
  assert.equal(fs.existsSync(marker), false);
});

// Needs root on Linux (real uid/gid drop). The controller runs it in a Linux container.
const rootLinux = process.platform === 'linux' && process.getuid?.() === 0;
test('production daemon: exec and pty children drop uid, gid and all supplementary groups', { skip: !rootLinux }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-root-')));
  fs.mkdirSync(path.join(dir, 'isolated', 'p1'), { recursive: true });
  fs.chownSync(path.join(dir, 'isolated', 'p1'), 20001, 20001);
  fs.chmodSync(dir, 0o755);
  const prod = await startDaemon({
    token: TOKEN, isolationDir: dir, dev: false, mainGid: 0,
    isolatedRoot: path.join(dir, 'isolated'), isolatedHomes: path.join(dir, 'homes'),
  });
  try {
    const body = JSON.stringify({ uid: 20001, name: 'P', allowlist: [], proxySecret: 's' });
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ socketPath: prod.socketPath, method: 'PUT', path: '/v1/projects/p1', headers: { Authorization: `Bearer ${TOKEN}` } }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end(body);
    });
    for (const kind of ['exec', 'pty'] as const) {
      const socket = await connectSpawn(prod.socketPath, TOKEN, request({
        kind, uid: 20001, projectDir: path.join(dir, 'isolated', 'p1'), cwd: path.join(dir, 'isolated', 'p1'),
        homeDir: path.join(dir, 'homes', 'p1'), args: ['grep -E "^(Uid|Gid|Groups):" /proc/self/status'],
      }));
      const out = text(await collect(socket), 'stdout');
      assert.match(out, /Uid:\s+20001\s+20001\s+20001\s+20001/, kind);
      assert.match(out, /Gid:\s+20001\s+20001\s+20001\s+20001/, kind);
      assert.match(out, /Groups:\s*\r?\n/, `${kind}: no supplementary groups`);
    }
  } finally {
    await prod.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
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

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
  daemon = await startDaemon({ token: TOKEN, isolationDir: tmp, dev: true });
});

after(async () => {
  await daemon.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function request(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    kind: 'exec',
    uid: 20001,
    projectDir: tmp,
    homeDir: tmp,
    args: ['true'],
    env: {},
    cwd: tmp,
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

test('pty is reported as not supported yet', async () => {
  const socket = await connectSpawn(daemon.socketPath, TOKEN, request({ kind: 'pty' }));
  const frames = await collect(socket);
  assert.match(text(frames, 'error'), /pty not supported yet/);
});

test('close() kills every live process group, grandchildren included', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-close-'));
  const local = await startDaemon({ token: TOKEN, isolationDir: dir, dev: true });
  const pidFile = path.join(dir, 'pids');
  await connectSpawn(
    local.socketPath,
    TOKEN,
    request({ args: [`sleep 60 & echo $! > ${pidFile}; exec sleep 60`] }),
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

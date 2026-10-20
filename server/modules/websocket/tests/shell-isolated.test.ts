import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { mock } from 'node:test';

import { WebSocket } from 'ws';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { daemonClient, isolationDb, runTokens, type SpawnRequest } from '@/modules/isolation/index.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';

const ENV_KEYS = ['CLOUDCLI_ISOLATED_ROOT', 'CLOUDCLI_ISOLATED_HOMES', 'CLOUDCLI_ISOLATION_DIR', 'CLOUDCLI_SANDBOX_DAEMON_TOKEN', 'DATABASE_PATH'] as const;

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { readyState: number; frames: string[]; send: (data: string) => void };
  socket.readyState = WebSocket.OPEN;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(data);
  return socket;
}

function fakeProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kills: [] as string[], sizes: [] as Array<[number, number]>,
    kill(signal: string) { proc.kills.push(signal); return true; },
    resize(cols: number, rows: number) { proc.sizes.push([cols, rows]); },
  });
  return proc;
}

async function withIsolatedProject(run: (projectPath: string) => Promise<void>) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const dir = fs.realpathSync(await mkdtemp(path.join(os.tmpdir(), 'shell-iso-')));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  process.env.CLOUDCLI_ISOLATED_ROOT = path.join(dir, 'isolated');
  process.env.CLOUDCLI_ISOLATED_HOMES = path.join(dir, 'homes');
  process.env.CLOUDCLI_ISOLATION_DIR = path.join(dir, 'iso');
  process.env.CLOUDCLI_SANDBOX_DAEMON_TOKEN = 'daemon-token';
  const projectPath = path.join(dir, 'isolated', 'shop');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(path.join(dir, 'homes'), { recursive: true });
  await initializeDatabase();
  try {
    const { project } = projectsDb.createProjectPath(projectPath, 'shop');
    isolationDb.markIsolated(project!.project_id, 20001);
    await run(projectPath);
  } finally {
    closeConnection();
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function connect(init: Record<string, unknown>, localSpawns: unknown[] = []) {
  const socket = createFakeSocket();
  handleShellConnection(socket as never, {
    resolveProviderSessionId: (id: string) => id,
    spawnPty: ((...args: unknown[]) => { localSpawns.push(args); throw new Error('local pty must not start'); }) as never,
  });
  socket.emit('message', JSON.stringify({ type: 'init', cols: 90, rows: 30, ...init }));
  return socket;
}

const outputOf = (socket: { frames: string[] }) =>
  socket.frames.map((f) => JSON.parse(f)).filter((m) => m.type === 'output').map((m) => m.data).join('');
const tick = () => new Promise((r) => setTimeout(r, 30));

test('isolated project: the terminal is a pty in the sandbox, input/resize/output go through it', async () => {
  await withIsolatedProject(async (projectPath) => {
    const proc = fakeProcess();
    const requests: SpawnRequest[] = [];
    const spawn = mock.method(daemonClient, 'spawn', ((request: SpawnRequest) => { requests.push(request); return proc as never; }) as never);
    const localSpawns: unknown[] = [];
    try {
      const socket = connect({ projectPath, sessionId: `iso-plain-${Date.now()}`, provider: 'plain-shell', isPlainShell: true, initialCommand: 'ls -la' }, localSpawns);
      await tick();
      assert.equal(localSpawns.length, 0);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].kind, 'pty');
      assert.deepEqual(requests[0].args, ['ls -la']);
      assert.equal(requests[0].env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.equal(runTokens.resolve(requests[0].env.CLOUDCLI_RUN_TOKEN)?.purpose, 'pty');
      assert.deepEqual(proc.sizes[0], [90, 30]);

      proc.stdout.write('output-from-sandbox');
      await tick();
      assert.match(outputOf(socket), /output-from-sandbox/);
      socket.emit('message', JSON.stringify({ type: 'input', data: 'x' }));
      assert.equal(proc.stdin.read()?.toString(), 'x');
      socket.emit('message', JSON.stringify({ type: 'resize', cols: 50, rows: 20 }));
      assert.deepEqual(proc.sizes.at(-1), [50, 20]);
    } finally {
      spawn.mock.restore();
      proc.emit('exit', 0, null);
    }
  });
});

test('isolated project: claude --resume runs in the sandbox with the Claude login bound to the session', async () => {
  await withIsolatedProject(async (projectPath) => {
    const proc = fakeProcess();
    const requests: SpawnRequest[] = [];
    const spawn = mock.method(daemonClient, 'spawn', ((request: SpawnRequest) => { requests.push(request); return proc as never; }) as never);
    try {
      const id = `iso-claude-${Date.now()}`;
      connect({ projectPath, sessionId: id, hasSession: true, provider: 'claude', colorScheme: 'light' });
      await tick();
      assert.match(requests[0].args[0], /^claude --resume "/);
      assert.doesNotMatch(requests[0].args[0], /--settings/, 'no main-side settings file in the sandbox');
      const env = requests[0].env;
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, env.CLOUDCLI_RUN_TOKEN);
      const token = runTokens.resolve(env.CLOUDCLI_RUN_TOKEN);
      assert.equal(token?.purpose, 'claude');
      assert.equal(token?.sessionId, id);
    } finally {
      spawn.mock.restore();
      proc.emit('exit', 0, null);
    }
  });
});

test('isolated project: other provider CLIs are refused in the terminal', async () => {
  await withIsolatedProject(async (projectPath) => {
    const requests: SpawnRequest[] = [];
    const spawn = mock.method(daemonClient, 'spawn', ((request: SpawnRequest) => { requests.push(request); return fakeProcess() as never; }) as never);
    const localSpawns: unknown[] = [];
    try {
      const socket = connect({ projectPath, sessionId: `iso-codex-${Date.now()}`, provider: 'codex' }, localSpawns);
      await tick();
      assert.match(outputOf(socket), /Izolovaný projekt podporuje jen Claude/);
      assert.equal(requests.length, 0);
      assert.equal(localSpawns.length, 0);
    } finally {
      spawn.mock.restore();
    }
  });
});

test('isolated project: sandbox down is written to the terminal, no local pty', async () => {
  await withIsolatedProject(async (projectPath) => {
    const proc = fakeProcess();
    const spawn = mock.method(daemonClient, 'spawn', (() => proc as never) as never);
    const localSpawns: unknown[] = [];
    try {
      const socket = connect({ projectPath, sessionId: `iso-down-${Date.now()}`, provider: 'plain-shell', isPlainShell: true, initialCommand: 'ls' }, localSpawns);
      await tick();
      proc.emit('error', new Error('Sandbox izolovaného projektu neběží (ENOENT)'));
      proc.stdout.end();
      proc.emit('exit', 1, null);
      await tick();
      assert.match(outputOf(socket), /Sandbox izolovaného projektu neběží/);
      assert.match(outputOf(socket), /Process exited with code 1/);
      assert.equal(localSpawns.length, 0);
    } finally {
      spawn.mock.restore();
    }
  });
});

test('isolated project: isolation unavailable on the instance refuses the terminal', async () => {
  await withIsolatedProject(async (projectPath) => {
    delete process.env.CLOUDCLI_ISOLATION_DIR;
    const localSpawns: unknown[] = [];
    const socket = connect({ projectPath, sessionId: `iso-off-${Date.now()}`, provider: 'plain-shell', isPlainShell: true, initialCommand: 'ls' }, localSpawns);
    await tick();
    assert.match(outputOf(socket), /Sandbox izolovaného projektu neběží/);
    assert.equal(localSpawns.length, 0);
  });
});

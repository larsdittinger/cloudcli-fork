import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { startDaemon, type RunningDaemon } from '@/modules/isolation/daemon/daemon.js';
import type { SpawnRequest } from '@/modules/isolation/daemon/process-host.js';
import { createDaemonClient, DaemonCallError, SANDBOX_DOWN_TEXT, type SandboxProcess } from '@/modules/isolation/daemon-client.js';
import type { IsolatedProject } from '@/modules/isolation/isolation.db.js';

const TOKEN = 'client-test-token';
let tmp: string;
let daemon: RunningDaemon;

function project(overrides: Partial<IsolatedProject> = {}): IsolatedProject {
  return {
    projectId: 'p1',
    projectPath: path.join(tmp, 'isolated', 'p1'),
    name: 'P1',
    uid: 20001,
    allowlist: ['ethia.cz'],
    tools: { channels: true, tasks: true },
    proxySecret: 'secret',
    homeDir: path.join(tmp, 'homes', 'p1'),
    ...overrides,
  };
}

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dcl-')));
  fs.mkdirSync(path.join(tmp, 'isolated', 'p1'), { recursive: true });
  daemon = await startDaemon({
    token: TOKEN, isolationDir: tmp, dev: true,
    isolatedRoot: path.join(tmp, 'isolated'), isolatedHomes: path.join(tmp, 'homes'), statOwner: () => 20001,
    selfCheckRunner: async (ctx) => ({ checks: [{ id: 'echo', ok: ctx.runToken === 'run-1', detail: ctx.request.projectDir }] }),
  });
});

after(async () => {
  await daemon.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const client = () => createDaemonClient(() => ({ socketPath: daemon.socketPath, token: TOKEN }));

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

type Outcome = { stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; errors: string[] };

function run(proc: SandboxProcess): Promise<Outcome> {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const errors: string[] = [];
  proc.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  proc.stderr.on('data', (chunk: Buffer) => err.push(chunk));
  proc.on('error', (error) => errors.push(error.message));
  return new Promise((resolve) => {
    proc.once('exit', (code, signal) => {
      // stdout ends before 'exit', like a child process whose pipes drained.
      resolve({ stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), code, signal, errors });
    });
  });
}

test('pushes the project before spawning; uid clash is a 409', async () => {
  const c = client();
  assert.deepEqual(await c.putProject(project()), { ok: true });
  await assert.rejects(c.putProject(project({ projectId: 'p2' })), (error: unknown) => error instanceof DaemonCallError && error.status === 409);
});

test('stdin round trip; stdin end is a frame, not a half-close', async () => {
  const proc = client().spawn(request({ args: ['cat; echo after-eof'] }));
  const done = run(proc);
  proc.stdin.write('hello ');
  proc.stdin.write(Buffer.from('sandbox'));
  proc.stdin.end();
  const result = await done;
  assert.equal(result.stdout, 'hello sandboxafter-eof\n');
  assert.equal(result.code, 0);
  assert.equal(proc.exitCode, 0);
  assert.deepEqual(result.errors, []);
});

test('stderr stays separate from stdout', async () => {
  const result = await run(client().spawn(request({ args: ['echo out; echo err >&2'] })));
  assert.equal(result.stdout, 'out\n');
  assert.equal(result.stderr, 'err\n');
});

test('exit code and signal are propagated; kill() marks the process killed', async () => {
  const three = await run(client().spawn(request({ args: ['exit 3'] })));
  assert.equal(three.code, 3);

  const proc = client().spawn(request({ args: ['sleep 60'] }));
  const done = run(proc);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(proc.kill('SIGTERM'), true);
  assert.equal(proc.killed, true);
  const result = await done;
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(proc.exitCode, null);
  assert.equal(proc.kill('SIGTERM'), false, 'nothing left to kill');
});

test('kill before the connection is up still reaches the daemon', async () => {
  const proc = client().spawn(request({ args: ['sleep 60'] }));
  const done = run(proc);
  proc.kill('SIGKILL');
  const result = await done;
  assert.ok(result.signal === 'SIGKILL' || result.code !== 0, JSON.stringify(result));
});

test('missing daemon socket: error with the sandbox text and exit 1', async () => {
  const proc = createDaemonClient(() => ({ socketPath: path.join(tmp, 'nope.sock'), token: TOKEN })).spawn(request());
  const result = await run(proc);
  assert.equal(result.code, 1);
  assert.equal(proc.exitCode, 1);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].startsWith(SANDBOX_DOWN_TEXT), result.errors[0]);
});

test('isolation not configured: error with the sandbox text and exit 1', async () => {
  const proc = createDaemonClient(() => ({ error: 'isolation is not configured' })).spawn(request());
  const result = await run(proc);
  assert.equal(result.code, 1);
  assert.match(result.errors[0], /Sandbox izolovaného projektu neběží \(isolation is not configured\)/);
});

test('rejected spawn (wrong uid) reports the daemon reason and exits 1', async () => {
  const result = await run(client().spawn(request({ uid: 20999 })));
  assert.equal(result.code, 1);
  assert.match(result.errors.join(' '), /uid does not match/);
});

test('wrong daemon token is reported, not hung', async () => {
  const proc = createDaemonClient(() => ({ socketPath: daemon.socketPath, token: 'wrong' })).spawn(request());
  const result = await run(proc);
  assert.equal(result.code, 1);
  assert.match(result.errors[0], /401/);
});

test('no error listener: a failure does not crash the app', async () => {
  const proc = createDaemonClient(() => ({ socketPath: path.join(tmp, 'nope.sock'), token: TOKEN })).spawn(request());
  const code = await new Promise((resolve) => proc.once('exit', (c) => resolve(c)));
  assert.equal(code, 1);
});

test('daemon going away mid-run: error + exit 1, no hang', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dcl2-')));
  fs.mkdirSync(path.join(dir, 'isolated', 'p1'), { recursive: true });
  const second = await startDaemon({ token: TOKEN, isolationDir: dir, dev: true, isolatedRoot: path.join(dir, 'isolated'), isolatedHomes: path.join(dir, 'homes'), statOwner: () => 20001 });
  try {
    const c = createDaemonClient(() => ({ socketPath: second.socketPath, token: TOKEN }));
    await c.putProject(project({ projectPath: path.join(dir, 'isolated', 'p1'), homeDir: path.join(dir, 'homes', 'p1') }));
    const proc = c.spawn(request({ args: ['sleep 60'], projectDir: path.join(dir, 'isolated', 'p1'), cwd: path.join(dir, 'isolated', 'p1'), homeDir: path.join(dir, 'homes', 'p1') }));
    const done = run(proc);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await second.close();
    const result = await done;
    assert.equal(result.code, 1);
    assert.ok(result.errors.some((e) => e.startsWith(SANDBOX_DOWN_TEXT)), JSON.stringify(result.errors));
  } finally {
    await second.close().catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('status, prepare, self-check and blocked', async () => {
  const c = client();
  const status = await c.status();
  assert.equal(status.running, true);
  assert.equal(status.ok, true);
  assert.equal(typeof status.projects, 'number');

  const down = await createDaemonClient(() => ({ socketPath: path.join(tmp, 'nope.sock'), token: TOKEN })).status();
  assert.equal(down.running, false);
  assert.ok(down.reason?.startsWith(SANDBOX_DOWN_TEXT));

  const prepared = await c.prepare(project());
  assert.equal(prepared.ok, true);
  await assert.rejects(c.prepare(project({ projectId: 'p9', uid: 20009 })), (error: unknown) => error instanceof DaemonCallError && error.status === 409);

  const checked = await c.selfCheck('p1', 'run-1', path.join(tmp, 'isolated', 'p1'));
  assert.deepEqual(checked.checks, [{ id: 'echo', ok: true, detail: path.join(tmp, 'isolated', 'p1') }]);

  assert.deepEqual(await c.blocked('p1'), []);
});

test('adopt hands app-written paths to the project; a 64 KiB+ spawn goes through', async () => {
  const c = client();
  await c.putProject(project());
  const dir = path.join(tmp, 'isolated', 'p1', '.cloudcli-attachments', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
  fs.chmodSync(path.join(dir, 'f.txt'), 0o600);
  assert.equal((await c.adopt(project(), ['.cloudcli-attachments/uploads'])).ok, true);
  assert.equal(fs.statSync(path.join(dir, 'f.txt')).mode & 0o060, 0o060);
  await assert.rejects(c.adopt(project(), ['../x']), (error: unknown) => error instanceof DaemonCallError && error.status === 400);

  const big = 'y'.repeat(80 * 1024);
  const outcome = await run(c.spawn(request({ args: [`echo ${big.length}`, big] })));
  assert.deepEqual(outcome.errors, []);
  assert.equal(outcome.stdout.trim(), String(big.length));
});

test('pty through the client: resize reaches the terminal, output and exit come back', async () => {
  const proc = client().spawn(request({ kind: 'pty', args: ['read x; stty size; exit 5'] }));
  proc.resize(44, 132);
  let out = '';
  proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
  const exit = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));
  setTimeout(() => proc.stdin.write('\n'), 300);
  assert.equal(await exit, 5);
  assert.match(out, /132 44/); // stty size: rows cols
});

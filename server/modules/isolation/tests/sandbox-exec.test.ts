import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { mock } from 'node:test';

import { projectsDb } from '@/modules/database/index.js';
import { daemonClient, SANDBOX_DOWN_TEXT, type SpawnRequest } from '@/modules/isolation/daemon-client.js';
import { isolationDb } from '@/modules/isolation/isolation.db.js';
import { runTokens } from '@/modules/isolation/run-tokens.js';
import { runInSandbox, startSandboxTerminal } from '@/modules/isolation/sandbox-exec.js';
import { isolationEnvFor, withIsolatedDatabase, withIsolationEnv } from '@/modules/isolation/tests/helpers.js';

function makeIsolated(dir: string, name = 'x', uid = 20001) {
  const projectPath = path.join(dir, 'isolated', name);
  fs.mkdirSync(projectPath, { recursive: true });
  const { project } = projectsDb.createProjectPath(projectPath, name);
  return isolationDb.markIsolated(project!.project_id, uid);
}

async function withIsolation(run: (dir: string) => Promise<void> | void) {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), () => run(dir));
  });
}

function fakeProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null as number | null,
    kills: [] as string[],
    sizes: [] as Array<[number, number]>,
    kill(signal: string) {
      proc.kills.push(signal);
      return true;
    },
    resize(cols: number, rows: number) {
      proc.sizes.push([cols, rows]);
    },
    end(code: number | null, signal: string | null = null) {
      proc.stdout.end();
      proc.emit('exit', code, signal);
    },
  });
  return proc;
}

function stubSpawn() {
  const proc = fakeProcess();
  const requests: SpawnRequest[] = [];
  const spawn = mock.method(daemonClient, 'spawn', ((request: SpawnRequest) => {
    requests.push(request);
    return proc as never;
  }) as never);
  return { proc, requests, restore: () => spawn.mock.restore() };
}

const NO_CLAUDE_KEYS = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER'];

test('runInSandbox: exec in the daemon with the sandbox env (no Claude login), output and exit code come back', async () => {
  await withIsolation(async (dir) => {
    const project = makeIsolated(dir);
    const { proc, requests, restore } = stubSpawn();
    process.env.SECRET_X = 'leak-me';
    try {
      const out: string[] = [];
      const err: string[] = [];
      const pending = runInSandbox({
        projectPath: project.projectPath, command: 'echo hi', env: { CLOUDCLI_SCHEDULE_ID: 's1' }, timeoutMs: 5000,
        onStdout: (t) => out.push(t), onStderr: (t) => err.push(t),
      });
      const request = requests[0];
      assert.equal(request.kind, 'exec');
      assert.equal(request.uid, project.uid);
      assert.equal(request.projectDir, project.projectPath);
      assert.deepEqual(request.args, ['echo hi']);
      assert.equal(request.env.CLOUDCLI_SCHEDULE_ID, 's1');
      assert.equal(request.env.SECRET_X, undefined);
      for (const key of NO_CLAUDE_KEYS) assert.equal(request.env[key], undefined, key);
      assert.equal(request.env.HTTPS_PROXY, `http://${project.projectId}:${project.proxySecret}@127.0.0.1:7702`);
      assert.equal(runTokens.resolve(request.env.CLOUDCLI_RUN_TOKEN)?.purpose, 'exec');

      proc.stdout.write('hello ');
      proc.stderr.write('warn\n');
      proc.stdout.write('world');
      proc.end(3);
      const result = await pending;
      assert.equal(out.join(''), 'hello world');
      assert.equal(err.join(''), 'warn\n');
      assert.equal(result.exitCode, 3);
      assert.equal(result.timedOut, false);
      assert.equal(runTokens.resolve(request.env.CLOUDCLI_RUN_TOKEN), null, 'token revoked on exit');
    } finally {
      delete process.env.SECRET_X;
      restore();
    }
  });
});

test('runInSandbox: a timeout sends SIGTERM, then SIGKILL after the grace period', async () => {
  await withIsolation(async (dir) => {
    const project = makeIsolated(dir);
    const { proc, restore } = stubSpawn();
    try {
      const pending = runInSandbox({
        projectPath: project.projectPath, command: 'sleep 99', timeoutMs: 30, killGraceMs: 60, onStdout: () => {}, onStderr: () => {},
      });
      await new Promise((r) => setTimeout(r, 15));
      assert.deepEqual(proc.kills, []);
      await new Promise((r) => setTimeout(r, 45));
      assert.deepEqual(proc.kills, ['SIGTERM']);
      await new Promise((r) => setTimeout(r, 80));
      assert.deepEqual(proc.kills, ['SIGTERM', 'SIGKILL']);
      proc.end(null, 'SIGKILL');
      const result = await pending;
      assert.equal(result.timedOut, true);
      assert.equal(result.signal, 'SIGKILL');
    } finally {
      restore();
    }
  });
});

test('runInSandbox: an unreachable sandbox is reported on stderr, not run locally', async () => {
  await withIsolation(async (dir) => {
    const project = makeIsolated(dir);
    const { proc, restore } = stubSpawn();
    try {
      const err: string[] = [];
      const pending = runInSandbox({ projectPath: project.projectPath, command: 'x', timeoutMs: 5000, onStdout: () => {}, onStderr: (t) => err.push(t) });
      proc.emit('error', new Error(`${SANDBOX_DOWN_TEXT} (ENOENT)`));
      proc.end(1);
      const result = await pending;
      assert.match(err.join(''), /Sandbox izolovaného projektu neběží/);
      assert.equal(result.exitCode, 1);
    } finally {
      restore();
    }
  });
});

test('runInSandbox: fails closed when isolation is unavailable or the path is no project', async () => {
  await withIsolation(async (dir) => {
    const project = makeIsolated(dir);
    const { requests, restore } = stubSpawn();
    try {
      await assert.rejects(runInSandbox({ projectPath: path.join(dir, 'isolated', 'ghost'), command: 'x', timeoutMs: 1, onStdout: () => {}, onStderr: () => {} }), /nepatří k izolovanému projektu/);
      await withIsolationEnv(null, async () => {
        await assert.rejects(runInSandbox({ projectPath: project.projectPath, command: 'x', timeoutMs: 1, onStdout: () => {}, onStderr: () => {} }), /Sandbox izolovaného projektu neběží/);
      });
      assert.equal(requests.length, 0);
    } finally {
      restore();
    }
  });
});

test('terminal: pty in the daemon, size sent, plain shell has a pty token and no Claude login', async () => {
  await withIsolation(async (dir) => {
    const project = makeIsolated(dir);
    const { proc, requests, restore } = stubSpawn();
    try {
      const term = startSandboxTerminal({ projectPath: project.projectPath, command: 'ls', cols: 120, rows: 40, claude: false });
      const request = requests[0];
      assert.equal(request.kind, 'pty');
      assert.deepEqual(request.args, ['ls']);
      for (const key of NO_CLAUDE_KEYS) assert.equal(request.env[key], undefined, key);
      assert.equal(runTokens.resolve(request.env.CLOUDCLI_RUN_TOKEN)?.purpose, 'pty');
      assert.deepEqual(proc.sizes, [[120, 40]]);

      const data: string[] = [];
      const exits: number[] = [];
      term.onData((d) => data.push(d));
      term.onExit((e) => exits.push(e.exitCode));
      proc.stdout.write('abc');
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(data, ['abc']);
      term.write('input');
      assert.equal(proc.stdin.read()?.toString(), 'input');
      term.resize(100, 30);
      assert.deepEqual(proc.sizes.at(-1), [100, 30]);
      term.kill();
      assert.deepEqual(proc.kills, ['SIGTERM']);
      proc.end(0);
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(exits, [0]);
      assert.equal(runTokens.resolve(request.env.CLOUDCLI_RUN_TOKEN), null);
    } finally {
      restore();
    }
  });
});

test('terminal: a Claude command gets the Claude login and a claude token bound to the session', async () => {
  await withIsolation(async (dir) => {
    const project = makeIsolated(dir);
    const { requests, restore } = stubSpawn();
    try {
      startSandboxTerminal({ projectPath: project.projectPath, command: 'claude', cols: 80, rows: 24, claude: true, sessionId: 's7' });
      const env = requests[0].env;
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, env.CLOUDCLI_RUN_TOKEN);
      assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:7701/anthropic');
      const token = runTokens.resolve(env.CLOUDCLI_RUN_TOKEN);
      assert.equal(token?.purpose, 'claude');
      assert.equal(token?.sessionId, 's7');
    } finally {
      restore();
    }
  });
});

test('terminal: a signal or lost daemon is a non-zero exit code', async () => {
  await withIsolation(async (dir) => {
    const project = makeIsolated(dir);
    const { proc, restore } = stubSpawn();
    try {
      const term = startSandboxTerminal({ projectPath: project.projectPath, command: 'x', cols: 80, rows: 24, claude: false });
      const exits: number[] = [];
      term.onExit((e) => exits.push(e.exitCode));
      proc.end(null, 'SIGKILL');
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(exits, [137]);
    } finally {
      restore();
    }
  });
});

test('runInSandbox: stderr written right before exit is not lost', async () => {
  await withIsolation(async (dir) => {
    const project = makeIsolated(dir);
    const { proc, restore } = stubSpawn();
    try {
      const err: string[] = [];
      const pending = runInSandbox({ projectPath: project.projectPath, command: 'x', timeoutMs: 5000, onStdout: () => {}, onStderr: (t) => err.push(t) });
      proc.stderr.write('late\n');
      proc.stderr.end();
      proc.end(1);
      await pending;
      assert.equal(err.join(''), 'late\n');
    } finally {
      restore();
    }
  });
});

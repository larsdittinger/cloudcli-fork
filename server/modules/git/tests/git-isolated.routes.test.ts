// Git of an isolated project: its .git/config and hooks are the agent's (core.fsmonitor, core.pager, hooks…), so
// git must never run in the main process for it — it runs in the sandbox as the project's uid, or is refused.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { mock } from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { createGitModule } from '@/modules/git/index.js';
import { daemonClient, isolationDb, type SpawnRequest } from '@/modules/isolation/index.js';

const ISOLATION_ENV = ['CLOUDCLI_ISOLATED_ROOT', 'CLOUDCLI_ISOLATED_HOMES', 'CLOUDCLI_ISOLATION_DIR', 'CLOUDCLI_SANDBOX_DAEMON_TOKEN'] as const;

type Ctx = { dir: string; base: string; isolatedId: string; isolatedRoot: string; plainId: string; marker: string; requests: SpawnRequest[] };

/** A fake sandbox: answers the git commands the status route runs, records every request. */
function fakeDaemon(projectRoot: string, toplevel = projectRoot) {
  const requests: SpawnRequest[] = [];
  const spawn = mock.method(daemonClient, 'spawn', ((request: SpawnRequest) => {
    requests.push(request);
    const proc = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, exitCode: null,
      kill: () => true, resize: () => undefined,
    });
    const command = request.args[0] ?? '';
    let out = '';
    if (command.includes("'--is-inside-work-tree'")) out = 'true\n';
    else if (command.includes("'--show-toplevel'")) out = `${toplevel}\n`;
    else if (command.includes("'symbolic-ref'")) out = 'main\n';
    else if (command.includes("'status'")) out = '?? new.txt\0?? link.txt\0';
    setImmediate(() => {
      proc.stdout.end(out);
      proc.stderr.end();
      proc.emit('exit', 0, null);
    });
    return proc as never;
  }) as never);
  return { requests, restore: () => spawn.mock.restore() };
}

async function withGit(run: (ctx: Ctx) => Promise<void>, toplevel?: (isolatedRoot: string) => string) {
  const dir = fs.realpathSync(await mkdtemp(path.join(os.tmpdir(), 'git-iso-')));
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

  // The agent's repository: a hook and an fsmonitor command that would run as the app if git ran here.
  const marker = path.join(dir, 'pwned');
  const isolatedRoot = path.join(env.CLOUDCLI_ISOLATED_ROOT, 'agent');
  fs.mkdirSync(isolatedRoot);
  execFileSync('git', ['init', '-q'], { cwd: isolatedRoot });
  execFileSync('git', ['config', 'core.fsmonitor', `touch ${marker}`], { cwd: isolatedRoot });
  execFileSync('git', ['config', 'core.pager', `touch ${marker}`], { cwd: isolatedRoot });
  fs.writeFileSync(path.join(isolatedRoot, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(isolatedRoot, 'new.txt'), 'new');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'MAIN-APP-SECRET');
  fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(isolatedRoot, 'link.txt'));
  const isolatedId = projectsDb.createProjectPath(isolatedRoot, 'agent').project!.project_id;
  isolationDb.markIsolated(isolatedId, 20001);

  const plainRoot = path.join(dir, 'workspace', 'plain');
  fs.mkdirSync(plainRoot, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: plainRoot });
  fs.writeFileSync(path.join(plainRoot, 'plain.txt'), 'x');
  const plainId = projectsDb.createProjectPath(plainRoot, 'plain').project!.project_id;

  const daemon = fakeDaemon(isolatedRoot, toplevel?.(isolatedRoot));
  const unexpected = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const app = express().use(express.json()).use('/api/git', createGitModule({ queryClaude: unexpected, queryCursor: unexpected }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run({ dir, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/git`, isolatedId, isolatedRoot, plainId, marker, requests: daemon.requests });
  } finally {
    daemon.restore();
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

test('git status of an isolated project runs in the sandbox, never in the app (fsmonitor/hooks do not fire)', async () => {
  await withGit(async ({ base, isolatedId, isolatedRoot, marker, requests }) => {
    const response = await fetch(`${base}/status?project=${isolatedId}`);
    const body = await response.json() as { untracked?: string[]; error?: string };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body.untracked?.sort(), ['link.txt', 'new.txt']);
    assert.equal(fs.existsSync(marker), false, 'a git hook ran in the main process');
    assert.ok(requests.length >= 3);
    for (const request of requests) {
      assert.equal(request.kind, 'exec');
      assert.equal(request.uid, 20001);
      assert.equal(request.projectDir, isolatedRoot);
      assert.match(request.args[0], /^'exec' 'git' '-c' 'user\.name=/);
      assert.equal(request.env.GIT_TERMINAL_PROMPT, '0');
      assert.equal(request.env.ANTHROPIC_BASE_URL, undefined);
    }
  });
});

test('git of an isolated project: network and identity routes are refused with 409, files are read safely', async () => {
  await withGit(async ({ base, isolatedId, marker, requests }) => {
    for (const route of ['push', 'pull', 'fetch', 'publish']) {
      const response = await fetch(`${base}/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: isolatedId, branch: 'main' }),
      });
      assert.equal(response.status, 409, route);
      assert.equal(((await response.json()) as { error: string }).error, 'Git is not available for isolated projects.');
    }
    assert.equal(requests.length, 0);

    // The diff of an untracked symlink must not show the file it points to.
    const diff = await fetch(`${base}/diff?project=${isolatedId}&file=link.txt`);
    assert.doesNotMatch(await diff.text(), /MAIN-APP-SECRET/);
    assert.equal(fs.existsSync(marker), false);
  });
});

test('git of an isolated project: a toplevel outside the project (agent output) never becomes a local cwd', async () => {
  await withGit(async ({ dir, base, isolatedId, marker }) => {
    const response = await fetch(`${base}/commit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: isolatedId, message: 'x', files: ['new.txt'] }),
    });
    assert.notEqual(response.status, 200);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(path.join(dir, 'workspace', 'plain', '.git', 'index')), false, 'git ran in another project');
  }, (isolatedRoot) => path.join(isolatedRoot, '..', '..', 'workspace', 'plain'));
});

test('git of a project that is not isolated still runs locally', async () => {
  await withGit(async ({ base, plainId, requests }) => {
    const response = await fetch(`${base}/status?project=${plainId}`);
    const body = await response.json() as { untracked?: string[] };
    assert.equal(response.status, 200);
    assert.deepEqual(body.untracked, ['plain.txt']);
    assert.equal(requests.length, 0);
  });
});

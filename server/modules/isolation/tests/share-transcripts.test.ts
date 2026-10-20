// C1: the Claude CLI writes its transcripts 0600 in directories it creates 0700. The app reads them as another
// uid (group = the app's gid), so the daemon adds the group read bits — without following anything the agent
// could have planted.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startDaemon } from '../daemon/daemon.js';
import { shareTranscripts } from '../daemon/projects.js';
import { projectsDb } from '@/modules/database/index.js';
import { isolationDb } from '@/modules/isolation/isolation.db.js';
import { startIsolatedTranscriptPoller } from '@/modules/isolation/isolation-transcripts.js';
import { isolationEnvFor, withIsolatedDatabase, withIsolationEnv } from '@/modules/isolation/tests/helpers.js';

const TOKEN = 'test-token';
const mode = (p: string) => fs.lstatSync(p).mode & 0o7777;

function tree(dir: string) {
  const root = path.join(dir, 'isolated');
  const homes = path.join(dir, 'homes');
  const home = path.join(homes, 'proj');
  const claude = path.join(home, '.claude');
  const projects = path.join(claude, 'projects');
  const enc = path.join(projects, '-isolated-proj');
  fs.mkdirSync(path.join(root, 'proj'), { recursive: true });
  fs.mkdirSync(path.join(enc, 'sess', 'subagents'), { recursive: true });
  // What the CLI does: mkdir(…, { mode: 0o700 }) and appendFile(…, { mode: 0o600 }).
  for (const d of [claude, projects, enc, path.join(enc, 'sess'), path.join(enc, 'sess', 'subagents')]) fs.chmodSync(d, 0o700);
  fs.writeFileSync(path.join(enc, 'sess.jsonl'), '{"type":"user"}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(enc, 'sess', 'subagents', 'agent-1.jsonl'), '{}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(enc, 'readable.jsonl'), '{}\n', { mode: 0o644 });
  return { root, homes, home, claude, projects, enc };
}

test('share pass (dev mode): group read on files, g+rx on directories, owner bits kept, nothing followed', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbxs-')));
  try {
    const t = tree(dir);
    const outsideFile = path.join(dir, 'outside.txt');
    fs.writeFileSync(outsideFile, 'secret', { mode: 0o600 });
    const outsideDir = path.join(dir, 'outside-dir');
    fs.mkdirSync(outsideDir, { mode: 0o700 });
    fs.chmodSync(outsideDir, 0o700);
    fs.symlinkSync(outsideFile, path.join(t.enc, 'link.jsonl'));
    fs.symlinkSync(outsideDir, path.join(t.enc, 'linkdir'));
    execFileSync('mkfifo', [path.join(t.enc, 'fifo.jsonl')]);
    fs.chmodSync(path.join(t.enc, 'fifo.jsonl'), 0o600);
    // Seven levels below projects: the walk stops at six like the app's own walk.
    let deep = t.projects;
    for (let level = 1; level <= 7; level += 1) {
      deep = path.join(deep, `d${level}`);
      fs.mkdirSync(deep, { mode: 0o700 });
      fs.chmodSync(deep, 0o700);
      fs.writeFileSync(path.join(deep, 'x.jsonl'), '{}\n', { mode: 0o600 });
    }

    const result = shareTranscripts({ projectId: 'proj', uid: 20001 }, { isolatedRoot: t.root, isolatedHomes: t.homes, statOwner: () => 20001, dev: true });
    assert.equal(result.truncated, false);
    assert.ok(result.changed > 0);
    for (const d of [t.claude, t.projects, t.enc, path.join(t.enc, 'sess'), path.join(t.enc, 'sess', 'subagents')]) {
      assert.equal(mode(d) & 0o777, 0o750, d);
    }
    assert.equal(mode(path.join(t.enc, 'sess.jsonl')), 0o640);
    assert.equal(mode(path.join(t.enc, 'sess', 'subagents', 'agent-1.jsonl')), 0o640);
    assert.equal(mode(path.join(t.enc, 'readable.jsonl')), 0o644, 'already readable: untouched');
    // Never through a symlink, never a FIFO.
    assert.equal(mode(outsideFile), 0o600);
    assert.equal(mode(outsideDir), 0o700);
    assert.equal(mode(path.join(t.enc, 'fifo.jsonl')), 0o600);
    // Depth: d1..d6 shared, d7 (and its file) not.
    assert.equal(mode(path.join(t.projects, 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'x.jsonl')), 0o640);
    assert.equal(mode(deep) & 0o777, 0o700);
    assert.equal(mode(path.join(deep, 'x.jsonl')), 0o600);
    // Nothing else in the home is touched.
    fs.writeFileSync(path.join(t.home, 'notes.txt'), 'x', { mode: 0o600 });
    shareTranscripts({ projectId: 'proj', uid: 20001 }, { isolatedRoot: t.root, isolatedHomes: t.homes, statOwner: () => 20001, dev: true });
    assert.equal(mode(path.join(t.home, 'notes.txt')), 0o600);

    // The entry budget bounds one call.
    for (let index = 0; index < 20; index += 1) fs.writeFileSync(path.join(t.enc, `bulk${index}.jsonl`), '{}\n', { mode: 0o600 });
    const capped = shareTranscripts({ projectId: 'proj', uid: 20001 }, { isolatedRoot: t.root, isolatedHomes: t.homes, statOwner: () => 20001, dev: true, limits: { maxEntries: 5 } });
    assert.equal(capped.truncated, true);
    assert.ok(capped.visited <= 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('share pass: a home without transcripts, or a .claude that is a symlink, is a no-op', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbxs-')));
  try {
    const root = path.join(dir, 'isolated');
    const homes = path.join(dir, 'homes');
    fs.mkdirSync(path.join(root, 'proj'), { recursive: true });
    const config = { isolatedRoot: root, isolatedHomes: homes, statOwner: () => 20001, dev: true };
    assert.equal(shareTranscripts({ projectId: 'proj', uid: 20001 }, config).changed, 0); // no home yet
    const elsewhere = path.join(dir, 'elsewhere', 'projects');
    fs.mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
    fs.chmodSync(elsewhere, 0o700);
    fs.mkdirSync(path.join(homes, 'proj'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(homes, 'proj', '.claude'));
    assert.equal(shareTranscripts({ projectId: 'proj', uid: 20001 }, config).changed, 0);
    assert.equal(mode(elsewhere), 0o700);
    assert.throws(() => shareTranscripts({ projectId: 'proj', uid: 5 }, config), /uid/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function call(socketPath: string, method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: urlPath, headers: { Authorization: `Bearer ${TOKEN}` } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('share-transcripts endpoint: validated like prepare', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbxs-')));
  const t = tree(dir);
  const daemon = await startDaemon({ token: TOKEN, isolationDir: path.join(dir, 'iso'), dev: true, isolatedRoot: t.root, isolatedHomes: t.homes, statOwner: () => 20001 });
  try {
    assert.equal((await call(daemon.socketPath, 'PUT', '/v1/projects/proj', { uid: 20001, name: 'P', allowlist: [], proxySecret: 's' })).status, 200);
    assert.equal((await call(daemon.socketPath, 'POST', '/v1/projects/ghost/share-transcripts', { uid: 20001 })).status, 409);
    assert.equal((await call(daemon.socketPath, 'POST', '/v1/projects/proj/share-transcripts', { uid: 20002 })).status, 409);
    assert.equal((await call(daemon.socketPath, 'POST', '/v1/projects/proj/share-transcripts', { uid: 7 })).status, 400);
    assert.equal((await call(daemon.socketPath, 'POST', '/v1/projects/proj/share-transcripts', {})).status, 400);
    assert.equal((await call(daemon.socketPath, 'POST', '/v1/projects/bad.id/share-transcripts', { uid: 20001 })).status, 400);
    const ok = await call(daemon.socketPath, 'POST', '/v1/projects/proj/share-transcripts', { uid: 20001 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.ok, true);
    assert.equal(mode(path.join(t.enc, 'sess.jsonl')), 0o640);
  } finally {
    await daemon.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Root on Linux: real uids. The transcript is written by uid 20000 exactly as the CLI writes it, and read by the
// app's uid (10001, group 10001 = CLOUDCLI_MAIN_GID) through the setgid home.
const rootLinux = process.platform === 'linux' && process.getuid?.() === 0;
test('production: the app uid can read a transcript the agent uid wrote 0600 in 0700 directories', { skip: !rootLinux && 'needs root on Linux' }, async () => {
  const APP = 10001;
  const AGENT = 20000;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbxs-root-')));
  fs.chmodSync(dir, 0o755);
  const root = path.join(dir, 'isolated');
  const homes = path.join(dir, 'homes');
  const home = path.join(homes, 'proj');
  fs.mkdirSync(path.join(root, 'proj'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  for (const d of [root, homes]) fs.chmodSync(d, 0o755);
  fs.chownSync(path.join(root, 'proj'), AGENT, APP);
  fs.chmodSync(path.join(root, 'proj'), 0o2770);
  // What prepare leaves: the home is the project's, group = the app's, setgid.
  fs.chownSync(home, AGENT, APP);
  fs.chmodSync(home, 0o2770);
  const transcript = path.join(home, '.claude', 'projects', '-isolated-proj', 'sess.jsonl');
  const subagent = path.join(path.dirname(transcript), 'sess', 'subagents', 'agent-1.jsonl');
  const write = spawnSync(process.execPath, ['-e', `
    process.umask(0o007);
    const fs = require('fs'), path = require('path');
    for (const f of ${JSON.stringify([transcript, subagent])}) {
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      fs.appendFileSync(f, '{"type":"user","message":"hi"}\\n', { mode: 0o600 });
    }
  `], { uid: AGENT, gid: AGENT, encoding: 'utf8' });
  assert.equal(write.status, 0, write.stderr);
  const readAsApp = (file: string) => spawnSync('cat', [file], { uid: APP, gid: APP, encoding: 'utf8' });
  assert.notEqual(readAsApp(transcript).status, 0, 'unreadable before the share pass (the bug)');

  const daemon = await startDaemon({
    token: TOKEN, isolationDir: path.join(dir, 'iso'), dev: false, mainGid: APP, clearGroups: () => undefined,
    isolatedRoot: root, isolatedHomes: homes, applyNetwork: async () => undefined,
  });
  try {
    assert.equal((await call(daemon.socketPath, 'PUT', '/v1/projects/proj', { uid: AGENT, name: 'P', allowlist: [], proxySecret: 's' })).status, 200);
    const res = await call(daemon.socketPath, 'POST', '/v1/projects/proj/share-transcripts', { uid: AGENT });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    for (const file of [transcript, subagent]) {
      const read = readAsApp(file);
      assert.equal(read.status, 0, `${file}: ${read.stderr}`);
      assert.match(read.stdout, /"message":"hi"/);
      const st = fs.statSync(file);
      assert.equal(st.uid, AGENT, 'owner unchanged');
      assert.equal(st.gid, APP);
      assert.equal(st.mode & 0o7777, 0o640);
    }
    const encDir = fs.statSync(path.dirname(transcript));
    assert.equal(encDir.uid, AGENT);
    assert.equal(encDir.mode & 0o7777, 0o2750);
    // The agent still writes its own transcript afterwards.
    const append = spawnSync(process.execPath, ['-e', `require('fs').appendFileSync(${JSON.stringify(transcript)}, 'more\\n')`], { uid: AGENT, gid: AGENT, encoding: 'utf8' });
    assert.equal(append.status, 0, append.stderr);
  } finally {
    await daemon.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the homes poller has the daemon share each isolated home before walking it', async () => {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      const projectPath = path.join(dir, 'isolated', 'shop');
      fs.mkdirSync(projectPath, { recursive: true });
      const id = projectsDb.createProjectPath(projectPath, 'shop').project!.project_id;
      const project = isolationDb.markIsolated(id, 20001);
      const claude = path.join(project.homeDir, '.claude');
      const enc = path.join(claude, 'projects', 'enc');
      fs.mkdirSync(enc, { recursive: true });
      fs.writeFileSync(path.join(enc, 'first.jsonl'), '{}\n');
      fs.mkdirSync(path.join(dir, 'homes', 'stray', '.claude', 'projects'), { recursive: true });
      // Unreadable for the app until the daemon's share pass ran (as the CLI leaves it).
      fs.chmodSync(claude, 0o000);
      const shared: string[] = [];
      const events: Array<[string, string]> = [];
      const poller = startIsolatedTranscriptPoller((event, file) => events.push([event, file]), {
        intervalMs: 60_000,
        share: async (p) => {
          shared.push(p.projectId);
          fs.chmodSync(claude, 0o750);
        },
      });
      try {
        await poller.tick();
        assert.deepEqual(shared, [id], 'once per home and cycle, only for isolated projects');
        fs.chmodSync(claude, 0o000);
        fs.chmodSync(claude, 0o750);
        fs.writeFileSync(path.join(enc, 'second.jsonl'), '{}\n');
        fs.chmodSync(claude, 0o000);
        await poller.tick();
        assert.deepEqual(shared, [id, id]);
        assert.deepEqual(events, [['add', path.join(enc, 'second.jsonl')]]);
      } finally {
        await poller.stop();
        fs.chmodSync(claude, 0o755);
      }
    });
  });
});

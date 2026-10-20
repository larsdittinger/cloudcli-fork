import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { isolationDb } from '@/modules/isolation/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';

/**
 * Transcripts of isolated projects live in their homes (<CLOUDCLI_ISOLATED_HOMES>/<projectId>/.claude/projects),
 * written by the agent. The synchronizer indexes them as sessions of that project — and nothing else.
 */

const encode = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-');

function line(sessionId: string, cwd: string) {
  return `${JSON.stringify({ type: 'user', sessionId, cwd, uuid: 'u1', message: { role: 'user', content: 'ahoj' } })}\n`;
}

const ISOLATION_ENV = ['CLOUDCLI_ISOLATED_ROOT', 'CLOUDCLI_ISOLATED_HOMES', 'CLOUDCLI_ISOLATION_DIR', 'CLOUDCLI_SANDBOX_DAEMON_TOKEN'] as const;

/** Fresh DB, isolation env under a temp dir, and a temp main home. */
async function withHomes(run: (ctx: { dir: string; homeOf: (id: string) => string }) => Promise<void>) {
  const dir = fs.realpathSync(await mkdtemp(path.join(os.tmpdir(), 'iso-sync-')));
  const previous = { db: process.env.DATABASE_PATH, ...Object.fromEntries(ISOLATION_ENV.map((key) => [key, process.env[key]])) } as Record<string, string | undefined>;
  const homes = path.join(dir, 'homes');
  const env: Record<string, string> = {
    CLOUDCLI_ISOLATED_ROOT: path.join(dir, 'isolated'),
    CLOUDCLI_ISOLATED_HOMES: homes,
    CLOUDCLI_ISOLATION_DIR: path.join(dir, 'iso'),
    CLOUDCLI_SANDBOX_DAEMON_TOKEN: 't',
  };
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
    if (key !== 'CLOUDCLI_SANDBOX_DAEMON_TOKEN') fs.mkdirSync(value, { recursive: true });
  }
  const originalHome = os.homedir;
  const mainHome = path.join(dir, 'main-home');
  fs.mkdirSync(path.join(mainHome, '.claude', 'projects'), { recursive: true });
  (os as { homedir: () => string }).homedir = () => mainHome;
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await run({ dir, homeOf: (id) => path.join(homes, id) });
  } finally {
    closeConnection();
    (os as { homedir: () => string }).homedir = originalHome;
    for (const key of ISOLATION_ENV) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    if (previous.db === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous.db;
    await rm(dir, { recursive: true, force: true });
  }
}

function isolatedProject(dir: string, name: string, uid: number) {
  const projectPath = path.join(dir, 'isolated', name);
  fs.mkdirSync(projectPath, { recursive: true });
  const { project } = projectsDb.createProjectPath(projectPath, name);
  return isolationDb.markIsolated(project!.project_id, uid);
}

function writeTranscript(home: string, cwd: string, sessionId: string, content = line(sessionId, cwd)) {
  const file = path.join(home, '.claude', 'projects', encode(cwd), `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

test('a transcript in an isolated home becomes a session of its project', async () => {
  await withHomes(async ({ dir, homeOf }) => {
    const project = isolatedProject(dir, 'x', 20001);
    writeTranscript(homeOf(project.projectId), project.projectPath, 'iso-session-1');
    const synchronizer = new ClaudeSessionSynchronizer();
    assert.equal(await synchronizer.synchronize(), 1);
    const session = sessionsDb.getSessionByProviderSessionId('iso-session-1');
    assert.equal(session?.project_path, project.projectPath);

    const second = writeTranscript(homeOf(project.projectId), path.join(project.projectPath, 'sub'), 'iso-session-2');
    assert.ok(await synchronizer.synchronizeFile(second));
  });
});

test('an isolated agent cannot plant sessions in other projects or point the app at other files', async () => {
  await withHomes(async ({ dir, homeOf }) => {
    const project = isolatedProject(dir, 'x', 20001);
    const other = isolatedProject(dir, 'y', 20002);
    const ceo = path.join(dir, 'workspace', 'ceo');
    fs.mkdirSync(ceo, { recursive: true });
    // A real session of the CEO project, in the main home.
    writeTranscript(os.homedir(), ceo, 'ceo-session');
    const synchronizer = new ClaudeSessionSynchronizer();
    await synchronizer.synchronize();
    const ceoRow = sessionsDb.getSessionByProviderSessionId('ceo-session');
    assert.equal(ceoRow?.project_path, ceo);

    const home = homeOf(project.projectId);
    const forged = [
      writeTranscript(home, ceo, 'forged-1'), // a cwd outside the project
      writeTranscript(home, other.projectPath, 'forged-2'), // another isolated project
      writeTranscript(home, project.projectPath, 'ceo-session'), // hijacks an existing session id
    ];
    // A symlink to a file of the app.
    const secret = path.join(dir, 'secret.jsonl');
    fs.writeFileSync(secret, line('forged-3', project.projectPath));
    const link = path.join(home, '.claude', 'projects', encode(project.projectPath), 'forged-3.jsonl');
    fs.symlinkSync(secret, link);

    await synchronizer.synchronize();
    for (const file of [...forged, link]) {
      assert.equal(await synchronizer.synchronizeFile(file), null, file);
    }
    assert.equal(sessionsDb.getSessionByProviderSessionId('forged-1'), null);
    assert.equal(sessionsDb.getSessionByProviderSessionId('forged-2'), null);
    assert.equal(sessionsDb.getSessionByProviderSessionId('forged-3'), null);
    const after = sessionsDb.getSessionByProviderSessionId('ceo-session');
    assert.equal(after?.project_path, ceo);
    assert.equal(after?.jsonl_path, ceoRow?.jsonl_path);
  });
});

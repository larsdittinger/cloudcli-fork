import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import '@/modules/isolation/index.js'; // registers the isolated homes as read-only roots
import { claudeTranscriptRoots, isIsolatedHomeWatchPath } from '@/modules/isolation/isolation-transcripts.js';
import { isolationEnvFor, withIsolatedDatabase, withIsolationEnv } from '@/modules/isolation/tests/helpers.js';
import { resolveReadOnlyRootPath } from '@/shared/utils.js';

async function withHomes(run: (ctx: { dir: string; env: ReturnType<typeof isolationEnvFor>; homeOf: (id: string) => string }) => Promise<void>) {
  await withIsolatedDatabase(async (dir) => {
    const env = isolationEnvFor(dir);
    const original = os.homedir;
    const mainHome = path.join(dir, 'main-home');
    fs.mkdirSync(path.join(mainHome, '.claude', 'projects'), { recursive: true });
    (os as { homedir: () => string }).homedir = () => mainHome;
    try {
      await withIsolationEnv(env, () => run({ dir, env, homeOf: (id) => path.join(env.CLOUDCLI_ISOLATED_HOMES, id) }));
    } finally {
      (os as { homedir: () => string }).homedir = original;
    }
  });
}

test('claudeTranscriptRoots: the main root plus every real isolated home', async () => {
  await withHomes(async ({ dir, homeOf }) => {
    fs.mkdirSync(path.join(homeOf('a'), '.claude', 'projects'), { recursive: true });
    fs.mkdirSync(homeOf('b'), { recursive: true }); // no transcripts yet
    fs.mkdirSync(path.join(dir, 'elsewhere', '.claude', 'projects'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'elsewhere'), homeOf('c'));
    fs.mkdirSync(path.join(homeOf('d'), '.claude'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'elsewhere', '.claude', 'projects'), path.join(homeOf('d'), '.claude', 'projects'));
    assert.deepEqual(claudeTranscriptRoots(), [
      path.join(os.homedir(), '.claude', 'projects'),
      path.join(homeOf('a'), '.claude', 'projects'),
    ]);
    // The file viewer may follow transcript paths into an isolated home's projects dir (admins only, read only).
    const transcript = path.join(homeOf('a'), '.claude', 'projects', 'p', 's.jsonl');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '{}\n');
    assert.equal(await resolveReadOnlyRootPath(transcript), fs.realpathSync(transcript));
    assert.equal(await resolveReadOnlyRootPath(path.join(homeOf('a'), '.bashrc')), null);
  });
});

test('the homes watcher only descends into .claude/projects', async () => {
  await withHomes(async ({ env }) => {
    const homes = env.CLOUDCLI_ISOLATED_HOMES;
    const watch = (rel: string) => isIsolatedHomeWatchPath(path.join(homes, rel));
    assert.equal(watch(''), true);
    assert.equal(watch('p1'), true);
    assert.equal(watch('p1/.claude'), true);
    assert.equal(watch('p1/.claude/projects'), true);
    assert.equal(watch('p1/.claude/projects/-isolated-x/s.jsonl'), true);
    assert.equal(watch('p1/node_modules'), false);
    assert.equal(watch('p1/.claude/settings.json'), false);
    assert.equal(watch('p1/.claude/projects/-isolated-x/s/subagents/agent-1.jsonl'), false);
    assert.equal(watch('../elsewhere'), false);
  });
});

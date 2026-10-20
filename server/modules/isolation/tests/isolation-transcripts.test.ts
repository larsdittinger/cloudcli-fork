import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import '@/modules/isolation/index.js'; // registers the isolated homes as read-only roots
import {
  claudeTranscriptRoots,
  findIsolatedTranscripts,
  isIsolatedHomeWatchPath,
  openTranscriptStream,
  readTranscriptText,
} from '@/modules/isolation/isolation-transcripts.js';
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

async function streamText(stream: NodeJS.ReadableStream): Promise<string> {
  let text = '';
  for await (const chunk of stream) text += chunk.toString();
  return text;
}

/** Fails the test instead of hanging when a read blocks (a FIFO opened for reading waits for a writer). */
function within<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`still blocked after ${ms} ms`)), ms); }),
  ]);
}

test('transcript reads: a regular file in an isolated home is read, outside paths as before', async () => {
  await withHomes(async ({ dir, homeOf }) => {
    const file = path.join(homeOf('p1'), '.claude', 'projects', 'enc', 's.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"a":1}\n');
    assert.equal(await streamText(await openTranscriptStream(file)), '{"a":1}\n');
    assert.equal(await readTranscriptText(file), '{"a":1}\n');
    assert.equal(await streamText(await openTranscriptStream(file, { maxBytes: 3 })), '{"a');

    const outside = path.join(dir, 'main-home', 'x.jsonl');
    fs.writeFileSync(outside, 'main');
    assert.equal(await readTranscriptText(outside), 'main');
  });
});

test('transcript reads: symlinks in an isolated home are refused, at the file or on the way', async () => {
  await withHomes(async ({ dir, homeOf }) => {
    const secret = path.join(dir, 'secret.jsonl');
    fs.writeFileSync(secret, 'SECRET');
    const projects = path.join(homeOf('p1'), '.claude', 'projects');
    fs.mkdirSync(path.join(projects, 'enc'), { recursive: true });
    const linkedFile = path.join(projects, 'enc', 'link.jsonl');
    fs.symlinkSync(secret, linkedFile);
    await assert.rejects(openTranscriptStream(linkedFile));
    await assert.rejects(readTranscriptText(linkedFile));

    fs.mkdirSync(path.join(dir, 'elsewhere'));
    fs.writeFileSync(path.join(dir, 'elsewhere', 's.jsonl'), 'SECRET');
    fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(projects, 'via'));
    await assert.rejects(openTranscriptStream(path.join(projects, 'via', 's.jsonl')));
    await assert.rejects(readTranscriptText(path.join(projects, 'via', 's.jsonl')));
  });
});

test('transcript reads: a FIFO in an isolated home is refused without blocking', async () => {
  await withHomes(async ({ homeOf }) => {
    const fifo = path.join(homeOf('p1'), '.claude', 'projects', 'enc', 'f.jsonl');
    fs.mkdirSync(path.dirname(fifo), { recursive: true });
    execFileSync('mkfifo', [fifo]);
    const started = Date.now();
    await within(assert.rejects(openTranscriptStream(fifo)));
    await within(assert.rejects(readTranscriptText(fifo)));
    assert.ok(Date.now() - started < 3000);
  });
});

test('the isolated walk is capped in depth and in files per home', async () => {
  await withHomes(async ({ homeOf }) => {
    const projects = path.join(homeOf('p1'), '.claude', 'projects');
    for (let index = 0; index < 5; index += 1) {
      fs.mkdirSync(path.join(projects, `enc${index}`), { recursive: true });
      fs.writeFileSync(path.join(projects, `enc${index}`, `s${index}.jsonl`), '{}');
    }
    const deep = path.join(projects, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'deep.jsonl'), '{}');
    fs.writeFileSync(path.join(projects, 'a', 'b', 'c', 'shallow.jsonl'), '{}');

    const all = await findIsolatedTranscripts(projects, null);
    assert.equal(all.length, 6);
    assert.ok(all.some((file) => file.endsWith('shallow.jsonl')));
    assert.equal(all.some((file) => file.endsWith('deep.jsonl')), false);
    assert.equal((await findIsolatedTranscripts(projects, null, { maxFiles: 3 })).length, 3);
  });
});

// Main-side readers of project config (MCP config, skills, package.json, custom commands) in isolated projects:
// a planted symlink must not leak an app file, a FIFO must not block, a write must not go through a link.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import '@/modules/isolation/index.js'; // registers the project file guard
import { commandsRoutes } from '@/modules/commands/index.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import { isolationEnvFor, withIsolatedDatabase, withIsolationEnv } from '@/modules/isolation/tests/helpers.js';
import { buildClaudeUserContent } from '@/shared/image-attachments.js';
import { readJsonConfig, readProviderSkillMarkdownDefinition, writeJsonConfig } from '@/shared/utils.js';

async function withProject(run: (ctx: { dir: string; project: string; secret: string }) => Promise<void>) {
  await withIsolatedDatabase(async (dir) => {
    const env = isolationEnvFor(dir);
    const project = path.join(env.CLOUDCLI_ISOLATED_ROOT, 'p');
    fs.mkdirSync(project, { recursive: true });
    const secret = path.join(dir, 'secret.json');
    fs.writeFileSync(secret, JSON.stringify({ name: 'LEAKED', mcpServers: { leaked: { command: 'x' } } }));
    await withIsolationEnv(env, () => run({ dir, project, secret }));
  });
}

function within<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`still blocked after ${ms} ms`)), ms);
    }),
  ]);
}

test('MCP config of an isolated project: no read or write through a symlink, no FIFO block; elsewhere unchanged', async () => {
  await withProject(async ({ dir, project, secret }) => {
    const mcp = path.join(project, '.mcp.json');
    fs.symlinkSync(secret, mcp);
    await assert.rejects(readJsonConfig(mcp), /symbolic links/);
    await assert.rejects(writeJsonConfig(mcp, { mcpServers: {} }), /symbolic links/);
    assert.match(fs.readFileSync(secret, 'utf8'), /LEAKED/);

    fs.unlinkSync(mcp);
    execFileSync('mkfifo', [mcp]);
    await within(assert.rejects(readJsonConfig(mcp)));
    fs.unlinkSync(mcp);

    await writeJsonConfig(path.join(project, 'sub', '.mcp.json'), { mcpServers: { a: { command: 'b' } } });
    assert.deepEqual(await readJsonConfig(path.join(project, 'sub', '.mcp.json')), { mcpServers: { a: { command: 'b' } } });
    assert.deepEqual(await readJsonConfig(path.join(project, 'missing.json')), {});

    // A path outside the isolated trees is read and written as before (symlinks included).
    const outside = path.join(dir, 'outside.json');
    fs.symlinkSync(secret, outside);
    assert.equal((await readJsonConfig(outside)).name, 'LEAKED');
  });
});

test('skills, package.json display name and custom commands of an isolated project are read safely', async () => {
  await withProject(async ({ dir, project, secret }) => {
    fs.mkdirSync(path.join(project, '.claude', 'skills', 'evil'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: LEAKED\n---\n');
    fs.symlinkSync(path.join(dir, 'SKILL.md'), path.join(project, '.claude', 'skills', 'evil', 'SKILL.md'));
    await assert.rejects(readProviderSkillMarkdownDefinition(path.join(project, '.claude', 'skills', 'evil', 'SKILL.md')));

    fs.symlinkSync(secret, path.join(project, 'package.json'));
    assert.equal(await generateDisplayName('p', project), 'p');
    fs.unlinkSync(path.join(project, 'package.json'));
    execFileSync('mkfifo', [path.join(project, 'package.json')]);
    assert.equal(await within(generateDisplayName('p', project)), 'p');

    fs.mkdirSync(path.join(project, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'creds.md'), 'TOKEN=supersecret');
    fs.symlinkSync(path.join(dir, 'creds.md'), path.join(project, '.claude', 'commands', 'leak.md'));
    fs.writeFileSync(path.join(project, '.claude', 'commands', 'ok.md'), 'hello $ARGUMENTS');
    const app = express().use(express.json()).use('/api/commands', commandsRoutes);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/commands`;
      const run = (name: string) => fetch(`${base}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commandName: `/${name}`, commandPath: path.join(project, '.claude', 'commands', `${name}.md`), rawArgs: 'x', context: { projectPath: project } }),
      });
      const leak = await run('leak');
      assert.notEqual(leak.status, 200);
      assert.doesNotMatch(await leak.text(), /supersecret/);
      const ok = await run('ok');
      assert.equal(ok.status, 200);
      assert.equal(((await ok.json()) as { content: string }).content, 'hello x');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test('an image in an isolated project that is a FIFO does not block the prompt', async () => {
  await withProject(async ({ project }) => {
    execFileSync('mkfifo', [path.join(project, 'pic.png')]);
    fs.writeFileSync(path.join(project, 'ok.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const blocks = await within(buildClaudeUserContent('look', [
      { path: path.join(project, 'pic.png'), mimeType: 'image/png' },
      { path: path.join(project, 'ok.png'), mimeType: 'image/png' },
    ], project));
    assert.equal(blocks.length, 2); // the prompt text and ok.png
  });
});

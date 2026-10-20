import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import '@/modules/isolation/index.js'; // registers the project file guard
import { ClaudeMcpProvider } from '@/modules/providers/list/claude/claude-mcp.provider.js';
import { CodexMcpProvider } from '@/modules/providers/list/codex/codex-mcp.provider.js';
import { isolationEnvFor, withIsolatedDatabase, withIsolationEnv } from '@/modules/providers/tests/isolation-test-env.js';

function within<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`still blocked after ${ms} ms`)), ms);
    }),
  ]);
}

test('MCP settings of an isolated project: Claude is guarded, other providers do not touch its files', async () => {
  await withIsolatedDatabase(async (dir) => {
    const env = isolationEnvFor(dir);
    await withIsolationEnv(env, async () => {
      const project = path.join(env.CLOUDCLI_ISOLATED_ROOT, 'p');
      fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
      execFileSync('mkfifo', [path.join(project, '.codex', 'config.toml')]);
      const codex = new CodexMcpProvider();
      assert.deepEqual(await within(codex.listServersForScope('project', { workspacePath: project })), []);
      await assert.rejects(
        codex.upsertServer({ name: 'x', scope: 'project', transport: 'stdio', command: 'x', workspacePath: project }),
        /Only Claude/,
      );

      const secret = path.join(dir, 'secret.json');
      fs.writeFileSync(secret, JSON.stringify({ mcpServers: { leaked: { command: 'x' } } }));
      fs.symlinkSync(secret, path.join(project, '.mcp.json'));
      const claude = new ClaudeMcpProvider();
      await assert.rejects(claude.listServersForScope('project', { workspacePath: project }));
      await assert.rejects(claude.upsertServer({ name: 'x', scope: 'project', transport: 'stdio', command: 'x', workspacePath: project }));
      assert.match(fs.readFileSync(secret, 'utf8'), /leaked/);

      fs.unlinkSync(path.join(project, '.mcp.json'));
      await claude.upsertServer({ name: 'ok', scope: 'project', transport: 'stdio', command: 'node', workspacePath: project });
      assert.deepEqual((await claude.listServersForScope('project', { workspacePath: project })).map((server) => server.name), ['ok']);
    });
  });
});

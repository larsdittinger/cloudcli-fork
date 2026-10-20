import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startDaemon, type NetworkState } from '../daemon/daemon.js';
import { createDaemonClient, DaemonCallError } from '../daemon-client.js';
import type { IsolatedProject } from '../isolation.db.js';

const TOKEN = 'test-token';

const project = (projectId: string, uid: number): IsolatedProject => ({
  projectId, projectPath: `/isolated/${projectId}`, name: projectId, uid, allowlist: [], tools: { channels: true, tasks: true }, proxySecret: `s-${projectId}`, homeDir: `/homes/${projectId}`,
});

test('a deleted project leaves the daemon: config, listing and firewall rules', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbxd-')));
  const applied: NetworkState[] = [];
  const daemon = await startDaemon({
    token: TOKEN, isolationDir: dir, dev: true, isolatedRoot: path.join(dir, 'isolated'), isolatedHomes: path.join(dir, 'homes'),
    applyNetwork: async (state) => { applied.push(state); },
  });
  const client = createDaemonClient(() => ({ socketPath: daemon.socketPath, token: TOKEN }));
  try {
    await client.putProject(project('keep', 20001));
    await client.putProject(project('gone', 20002));
    assert.deepEqual((await client.listProjects()).sort(), ['gone', 'keep']);
    assert.ok(applied.at(-1)!.rules4.some((rule) => rule.includes('--uid-owner 20002 ')));

    assert.deepEqual(await client.deleteProject('gone'), { removed: true });
    assert.deepEqual(await client.listProjects(), ['keep']);
    assert.equal((await client.status()).projects, 1);
    assert.ok(!applied.at(-1)!.rules4.some((rule) => rule.includes('--uid-owner 20002 ')), 'its uid only hits the catch-all now');
    // Persisted: a restarted daemon does not bring it back.
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'projects.json'), 'utf8'));
    assert.deepEqual(Object.keys(saved), ['keep']);
    // Its uid is free again for another project.
    await client.putProject(project('next', 20002));

    assert.deepEqual(await client.deleteProject('never-there'), { removed: false });
    await assert.rejects(client.deleteProject('../x'), (error: unknown) => error instanceof DaemonCallError && error.status === 400);
  } finally {
    await daemon.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

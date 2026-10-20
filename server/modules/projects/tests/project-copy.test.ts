import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { mock } from 'node:test';

import { projectsDb } from '@/modules/database/index.js';
import { daemonClient, isolationDb } from '@/modules/isolation/index.js';
import { withIsolationDirs, withTempDatabase } from '@/modules/projects/tests/copy-helpers.js';
import {
  getCopyJob,
  previewCopy,
  slugifyProjectName,
  startCopy,
  waitForCopyJob,
  type CopyDependencies,
  type CopyInput,
} from '@/modules/projects/services/project-copy.service.js';

function makeSource(dir: string, name = 'zdroj') {
  const sourcePath = path.join(dir, 'work', name);
  fs.mkdirSync(path.join(sourcePath, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(sourcePath, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(sourcePath, '.hidden'), 'dot');
  fs.writeFileSync(path.join(sourcePath, 'sub', 'b.txt'), 'bee');
  const { project } = projectsDb.createProjectPath(sourcePath, name);
  return { sourcePath, projectId: project!.project_id };
}

const input = (overrides: Partial<CopyInput> = {}): CopyInput => ({
  name: 'Kopie',
  isolated: false,
  excludeSecretFiles: [],
  carryMcp: [],
  ...overrides,
});

const validatePath = async (candidate: string) => ({ valid: true, resolvedPath: candidate });

async function finish(projectId: string, copy: CopyInput, deps: CopyDependencies = {}) {
  const { jobId } = await startCopy(projectId, copy, { validatePath, ...deps });
  await waitForCopyJob(jobId);
  return getCopyJob(jobId)!;
}

test('slugifyProjectName strips diacritics and unsafe characters', () => {
  assert.equal(slugifyProjectName('Podpora e-mail'), 'podpora-e-mail');
  assert.equal(slugifyProjectName('Příliš žluťoučký  kůň!'), 'prilis-zlutoucky-kun');
  assert.equal(slugifyProjectName('../../etc'), 'etc');
  assert.equal(slugifyProjectName('???'), 'projekt');
});

test('copies files including dotfiles and registers the project', async () => {
  await withTempDatabase(async (dir) => {
    const { projectId, sourcePath } = makeSource(dir);
    const job = await finish(projectId, input({ name: 'Kopie ěš' }), { claudeJsonPath: path.join(dir, 'claude.json') });
    assert.equal(job.error, undefined);
    assert.equal(job.done, true);
    const target = path.join(path.dirname(sourcePath), 'kopie-es');
    assert.equal(fs.readFileSync(path.join(target, '.hidden'), 'utf8'), 'dot');
    assert.equal(fs.readFileSync(path.join(target, 'sub', 'b.txt'), 'utf8'), 'bee');
    assert.equal(job.copiedBytes, job.totalBytes);
    assert.ok(job.totalBytes! >= 11);
    const row = projectsDb.getProjectPath(target)!;
    assert.equal(row.custom_project_name, 'Kopie ěš');
    assert.equal(job.project?.projectId, row.project_id);
  });
});

test('copies .git and keeps the executable bit', async () => {
  await withTempDatabase(async (dir) => {
    const { projectId, sourcePath } = makeSource(dir);
    execFileSync('git', ['init', '-q'], { cwd: sourcePath });
    fs.writeFileSync(path.join(sourcePath, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    const job = await finish(projectId, input());
    const target = path.join(path.dirname(sourcePath), 'kopie');
    assert.ok(fs.existsSync(path.join(target, '.git', 'HEAD')));
    assert.equal(fs.statSync(path.join(target, 'run.sh')).mode & 0o111, 0o111);
    assert.equal(job.error, undefined);
  });
});

test('excludes chosen secret files', async () => {
  await withTempDatabase(async (dir) => {
    const { projectId, sourcePath } = makeSource(dir);
    fs.writeFileSync(path.join(sourcePath, '.env'), 'KEY=1');
    fs.writeFileSync(path.join(sourcePath, 'sub', 'server.pem'), 'x');
    const job = await finish(projectId, input({ excludeSecretFiles: ['.env'] }));
    const target = path.join(path.dirname(sourcePath), 'kopie');
    assert.equal(fs.existsSync(path.join(target, '.env')), false);
    assert.equal(fs.existsSync(path.join(target, 'sub', 'server.pem')), true);
    assert.equal(job.error, undefined);
  });
});

test('preview lists secret files, size and the user-scope MCP servers', async () => {
  await withTempDatabase(async (dir) => {
    const { projectId, sourcePath } = makeSource(dir, 'Podpora e-mail');
    fs.writeFileSync(path.join(sourcePath, '.env.local'), 'A=1');
    fs.writeFileSync(path.join(sourcePath, 'sub', 'id.key'), 'k');
    fs.writeFileSync(path.join(sourcePath, 'credentials-google.json'), '{}');
    fs.writeFileSync(path.join(sourcePath, '.mcp.json'), JSON.stringify({ mcpServers: { s: { command: 'x', env: { T: '1' } } } }));
    fs.writeFileSync(path.join(sourcePath, 'sub', '.mcp.json'), JSON.stringify({ mcpServers: { s: { command: 'x', env: {} } } }));
    const claudeJsonPath = path.join(dir, 'claude.json');
    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      projects: { [sourcePath]: { mcpServers: { gdrive: { command: 'npx', env: { TOKEN: 'abc' } }, plain: { command: 'node' } } } },
    }));
    const preview = await previewCopy(projectId, { claudeJsonPath });
    assert.equal(preview.suggestedName, 'Podpora e-mail (kopie)');
    assert.deepEqual([...preview.secretFiles].sort(), ['.env.local', '.mcp.json', 'credentials-google.json', 'sub/id.key']);
    assert.equal(preview.fileCount, 8);
    assert.ok(preview.sizeBytes > 0);
    assert.deepEqual(preview.userScopeMcp.sort((a, b) => a.name.localeCompare(b.name)), [
      { name: 'gdrive', hasSecrets: true },
      { name: 'plain', hasSecrets: false },
    ]);
    assert.equal(preview.isolationAvailable, false);
  });
});

test('slug collision gets -2, -3', async () => {
  await withTempDatabase(async (dir) => {
    const { projectId, sourcePath } = makeSource(dir, 'Podpora e-mail');
    const first = await finish(projectId, input({ name: 'Podpora e-mail' }));
    const second = await finish(projectId, input({ name: 'Podpora e-mail' }));
    const third = await finish(projectId, input({ name: 'Podpora e-mail' }));
    const parent = path.dirname(sourcePath);
    assert.deepEqual([first, second, third].map((job) => job.project?.fullPath), [
      path.join(parent, 'podpora-e-mail'),
      path.join(parent, 'podpora-e-mail-2'),
      path.join(parent, 'podpora-e-mail-3'),
    ]);
  });
});

test('cleanup on failure removes the partial target and registers nothing', async () => {
  await withTempDatabase(async (dir) => {
    const { projectId, sourcePath } = makeSource(dir);
    let seen = 0;
    const job = await finish(projectId, input(), {
      afterEntry: () => {
        seen += 1;
        if (seen === 2) throw new Error('disk exploded');
      },
    });
    assert.match(job.error ?? '', /disk exploded/);
    assert.equal(fs.existsSync(path.join(path.dirname(sourcePath), 'kopie')), false);
    assert.equal(projectsDb.getProjectPath(path.join(path.dirname(sourcePath), 'kopie')), null);
  });
});

test('symlinks: inside kept as relative link, outside skipped with a warning', async () => {
  await withTempDatabase(async (dir) => {
    const { projectId, sourcePath } = makeSource(dir);
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside');
    fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(sourcePath, 'out-abs'));
    fs.symlinkSync('../../secret.txt', path.join(sourcePath, 'sub', 'out-rel'));
    fs.symlinkSync(path.join(sourcePath, 'a.txt'), path.join(sourcePath, 'in-abs'));
    fs.symlinkSync('../a.txt', path.join(sourcePath, 'sub', 'in-rel'));
    const job = await finish(projectId, input());
    const target = path.join(path.dirname(sourcePath), 'kopie');
    assert.equal(fs.existsSync(path.join(target, 'out-abs')), false);
    assert.equal(fs.lstatSync(path.join(target, 'out-abs'), { throwIfNoEntry: false }), undefined);
    assert.equal(fs.lstatSync(path.join(target, 'sub', 'out-rel'), { throwIfNoEntry: false }), undefined);
    assert.equal(fs.readlinkSync(path.join(target, 'in-abs')), 'a.txt');
    assert.equal(fs.readlinkSync(path.join(target, 'sub', 'in-rel')), '../a.txt');
    assert.equal(fs.readFileSync(path.join(target, 'in-abs'), 'utf8'), 'hello');
    assert.equal(job.warnings.filter((warning) => /out-abs|out-rel/.test(warning)).length, 2);
  });
});

test('FIFOs are skipped, not read', async () => {
  await withTempDatabase(async (dir) => {
    const { projectId, sourcePath } = makeSource(dir);
    execFileSync('mkfifo', [path.join(sourcePath, 'pipe')]);
    const job = await finish(projectId, input());
    const target = path.join(path.dirname(sourcePath), 'kopie');
    assert.equal(fs.lstatSync(path.join(target, 'pipe'), { throwIfNoEntry: false }), undefined);
    assert.ok(job.warnings.some((warning) => warning.includes('pipe')));
    assert.equal(job.error, undefined);
  });
});

test('carryMcp for a non-isolated copy goes to ~/.claude.json projects[target]', async () => {
  await withTempDatabase(async (dir) => {
    const { projectId, sourcePath } = makeSource(dir);
    const claudeJsonPath = path.join(dir, 'claude.json');
    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      other: 1,
      projects: { [sourcePath]: { mcpServers: { gdrive: { command: 'npx' }, other: { command: 'z' } } } },
    }));
    const job = await finish(projectId, input({ carryMcp: ['gdrive'] }), { claudeJsonPath });
    assert.equal(job.error, undefined);
    const target = path.join(path.dirname(sourcePath), 'kopie');
    const written = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    assert.deepEqual(written.projects[target].mcpServers, { gdrive: { command: 'npx' } });
    assert.equal(written.other, 1);
    assert.ok(written.projects[sourcePath].mcpServers.other);
  });
});

test('carryMcp with an unknown server name is rejected before anything is copied', async () => {
  await withTempDatabase(async (dir) => {
    const { projectId, sourcePath } = makeSource(dir);
    await assert.rejects(startCopy(projectId, input({ carryMcp: ['nope'] }), { validatePath, claudeJsonPath: path.join(dir, 'none.json') }), /nope/);
    assert.equal(fs.existsSync(path.join(path.dirname(sourcePath), 'kopie')), false);
  });
});

test('isolated unavailable -> 409 and nothing is created', async () => {
  await withTempDatabase(async (dir) => {
    await withIsolationDirs(null, async () => {
      const { projectId, sourcePath } = makeSource(dir);
      await assert.rejects(startCopy(projectId, input({ isolated: true }), { validatePath }), (error: any) => error.statusCode === 409);
      assert.equal(fs.existsSync(path.join(path.dirname(sourcePath), 'kopie')), false);
    });
  });
});

test('isolated copy marks project, pushes it and calls prepare', async () => {
  await withTempDatabase(async (dir) => {
    await withIsolationDirs(dir, async () => {
      const { projectId } = makeSource(dir);
      const calls: string[] = [];
      mock.method(daemonClient, 'status', async () => ({ running: true, ok: true }));
      mock.method(daemonClient, 'putProject', async (project: { uid: number }) => { calls.push(`put:${project.uid}`); return { ok: true as const }; });
      mock.method(daemonClient, 'prepare', async (project: { uid: number }) => { calls.push(`prepare:${project.uid}`); return { ok: true, warnings: ['w1'] }; });
      try {
        const job = await finish(projectId, input({ name: 'Izolovaný', isolated: true }));
        assert.equal(job.error, undefined);
        const target = path.join(dir, 'isolated', 'izolovany');
        assert.equal(job.project?.fullPath, target);
        assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'hello');
        const isolated = isolationDb.getByPath(target)!;
        assert.equal(isolated.uid, 20000);
        assert.deepEqual(calls, ['put:20000', 'prepare:20000']);
        assert.ok(job.warnings.includes('w1'));
        // Source stays a plain project.
        assert.equal(isolationDb.getById(projectId), null);
      } finally {
        mock.restoreAll();
      }
    });
  });
});

test('isolated copy with the daemon down fails clearly and leaves no project or files', async () => {
  await withTempDatabase(async (dir) => {
    await withIsolationDirs(dir, async () => {
      const { projectId } = makeSource(dir);
      mock.method(daemonClient, 'status', async () => ({ running: true, ok: true }));
      mock.method(daemonClient, 'putProject', async () => { throw new Error('Sandbox izolovaného projektu neběží (test)'); });
      try {
        const job = await finish(projectId, input({ isolated: true }));
        assert.match(job.error ?? '', /neběží/);
        const target = path.join(dir, 'isolated', 'kopie');
        assert.equal(fs.existsSync(target), false);
        assert.equal(projectsDb.getProjectPath(target), null);
        assert.equal(isolationDb.listIsolated().length, 0);
      } finally {
        mock.restoreAll();
      }
    });
  });
});

test('isolated copy refuses up front (409) when the daemon is not running', async () => {
  await withTempDatabase(async (dir) => {
    await withIsolationDirs(dir, async () => {
      const { projectId } = makeSource(dir);
      mock.method(daemonClient, 'status', async () => ({ running: false, ok: false, reason: 'down' }));
      try {
        await assert.rejects(startCopy(projectId, input({ isolated: true }), { validatePath }), (error: any) => error.statusCode === 409 && /neběží/.test(error.message));
        assert.equal(fs.existsSync(path.join(dir, 'isolated', 'kopie')), false);
      } finally {
        mock.restoreAll();
      }
    });
  });
});

test('carryMcp into .mcp.json for an isolated copy merges and enables the servers', async () => {
  await withTempDatabase(async (dir) => {
    await withIsolationDirs(dir, async () => {
      const { projectId, sourcePath } = makeSource(dir);
      fs.writeFileSync(path.join(sourcePath, '.mcp.json'), JSON.stringify({ mcpServers: { existing: { command: 'e' } } }));
      fs.mkdirSync(path.join(sourcePath, '.claude'));
      fs.writeFileSync(path.join(sourcePath, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['existing'], keep: true }));
      const claudeJsonPath = path.join(dir, 'claude.json');
      fs.writeFileSync(claudeJsonPath, JSON.stringify({ projects: { [sourcePath]: { mcpServers: { gdrive: { command: 'npx' } } } } }));
      mock.method(daemonClient, 'status', async () => ({ running: true, ok: true }));
      mock.method(daemonClient, 'putProject', async () => ({ ok: true as const }));
      mock.method(daemonClient, 'prepare', async () => ({ ok: true, warnings: [] }));
      try {
        const job = await finish(projectId, input({ isolated: true, carryMcp: ['gdrive'] }), { claudeJsonPath });
        assert.equal(job.error, undefined);
        const target = path.join(dir, 'isolated', 'kopie');
        const mcp = JSON.parse(fs.readFileSync(path.join(target, '.mcp.json'), 'utf8'));
        assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ['existing', 'gdrive']);
        const local = JSON.parse(fs.readFileSync(path.join(target, '.claude', 'settings.local.json'), 'utf8'));
        assert.deepEqual([...local.enabledMcpjsonServers].sort(), ['existing', 'gdrive']);
        assert.equal(local.keep, true);
        // ~/.claude.json of the app is not touched for the isolated target.
        assert.equal(JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')).projects[target], undefined);
      } finally {
        mock.restoreAll();
      }
    });
  });
});

test('an isolated source is read without following symlinks or blocking on FIFOs', async () => {
  await withTempDatabase(async (dir) => {
    await withIsolationDirs(dir, async () => {
      const sourcePath = path.join(dir, 'isolated', 'agent');
      fs.mkdirSync(sourcePath, { recursive: true });
      fs.writeFileSync(path.join(sourcePath, 'a.txt'), 'hello');
      fs.writeFileSync(path.join(dir, 'app-secret'), 'SECRET');
      fs.symlinkSync(path.join(dir, 'app-secret'), path.join(sourcePath, 'leak'));
      execFileSync('mkfifo', [path.join(sourcePath, 'pipe')]);
      const projectId = projectsDb.createProjectPath(sourcePath, 'agent').project!.project_id;
      isolationDb.markIsolated(projectId, isolationDb.allocateUid());
      mock.method(daemonClient, 'status', async () => ({ running: true, ok: true }));
      mock.method(daemonClient, 'putProject', async () => ({ ok: true as const }));
      mock.method(daemonClient, 'prepare', async () => ({ ok: true, warnings: [] }));
      try {
        const job = await Promise.race([
          finish(projectId, input({ isolated: true })),
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('copy blocked')), 5000)),
        ]);
        assert.equal(job.error, undefined);
        const copied = job.project!.fullPath;
        assert.equal(copied, path.join(dir, 'isolated', 'kopie'));
        assert.equal(fs.readFileSync(path.join(copied, 'a.txt'), 'utf8'), 'hello');
        assert.equal(fs.lstatSync(path.join(copied, 'leak'), { throwIfNoEntry: false }), undefined);
        assert.equal(fs.lstatSync(path.join(copied, 'pipe'), { throwIfNoEntry: false }), undefined);
        assert.ok(job.warnings.length >= 2);
        assert.equal(isolationDb.getByPath(copied)!.uid, 20001);
      } finally {
        mock.restoreAll();
      }
    });
  });
});

const fakeDaemon = () => {
  mock.method(daemonClient, 'status', async () => ({ running: true, ok: true }));
  mock.method(daemonClient, 'putProject', async () => ({ ok: true as const }));
  mock.method(daemonClient, 'prepare', async () => ({ ok: true, warnings: [] }));
};

test('isolated copy passes the REAL path validator with ISOLATED_ROOT outside WORKSPACES_ROOT', async () => {
  await withTempDatabase(async (dir) => {
    await withIsolationDirs(dir, async () => {
      const { projectId } = makeSource(dir);
      fakeDaemon();
      try {
        const job = await finish(projectId, input({ isolated: true }), { validatePath: undefined });
        assert.equal(job.error, undefined);
        assert.equal(job.project?.fullPath, path.join(dir, 'isolated', 'kopie'));
      } finally {
        mock.restoreAll();
      }
    });
  });
});

test('a non-isolated copy of an isolated source is allowed and lands in the workspaces root', async () => {
  await withTempDatabase(async (dir) => {
    await withIsolationDirs(dir, async () => {
      const sourcePath = path.join(dir, 'isolated', 'agent');
      fs.mkdirSync(sourcePath, { recursive: true });
      fs.writeFileSync(path.join(sourcePath, 'a.txt'), 'hello');
      fs.writeFileSync(path.join(dir, 'app-secret'), 'SECRET');
      fs.symlinkSync(path.join(dir, 'app-secret'), path.join(sourcePath, 'leak'));
      const projectId = projectsDb.createProjectPath(sourcePath, 'agent').project!.project_id;
      isolationDb.markIsolated(projectId, isolationDb.allocateUid());
      const workspacesRoot = path.join(dir, 'ws');
      fs.mkdirSync(workspacesRoot);
      const job = await finish(projectId, input({ name: 'Venku' }), { workspacesRoot });
      assert.equal(job.error, undefined);
      assert.equal(job.project?.fullPath, path.join(workspacesRoot, 'venku'));
      assert.equal(fs.readFileSync(path.join(workspacesRoot, 'venku', 'a.txt'), 'utf8'), 'hello');
      assert.equal(fs.lstatSync(path.join(workspacesRoot, 'venku', 'leak'), { throwIfNoEntry: false }), undefined);
      assert.equal(isolationDb.getByPath(workspacesRoot), null);
    });
  });
});

test('a plain source that contains an isolation area is refused', async () => {
  await withTempDatabase(async (dir) => {
    await withIsolationDirs(dir, async () => {
      const projectId = projectsDb.createProjectPath(dir, 'whole').project!.project_id; // contains isolated/, homes/, iso/
      await assert.rejects(startCopy(projectId, input(), { validatePath }), (error: any) => error.statusCode === 400 && /isolat/i.test(error.message));
      assert.equal(fs.existsSync(path.join(path.dirname(dir), 'kopie')), false);
    });
  });
});

test('excluding a directory skips the whole subtree', async () => {
  await withTempDatabase(async (dir) => {
    const { projectId, sourcePath } = makeSource(dir);
    fs.mkdirSync(path.join(sourcePath, 'keys'));
    fs.writeFileSync(path.join(sourcePath, 'keys', 'x.txt'), 'x');
    const job = await finish(projectId, input({ excludeSecretFiles: ['keys'] }));
    assert.equal(job.error, undefined);
    assert.equal(fs.existsSync(path.join(path.dirname(sourcePath), 'kopie', 'keys')), false);
    assert.equal(fs.existsSync(path.join(path.dirname(sourcePath), 'kopie', 'a.txt')), true);
  });
});

test('preview flags credentials dotfiles and ssh private keys', async () => {
  await withTempDatabase(async (dir) => {
    const { projectId, sourcePath } = makeSource(dir);
    for (const name of ['.credentials.json', 'id_rsa', 'id_ed25519', 'sub/id_ecdsa', 'id_rsa.pub']) fs.writeFileSync(path.join(sourcePath, name), 'k');
    const preview = await previewCopy(projectId);
    assert.deepEqual([...preview.secretFiles].sort(), ['.credentials.json', 'id_ed25519', 'id_rsa', 'sub/id_ecdsa']);
  });
});

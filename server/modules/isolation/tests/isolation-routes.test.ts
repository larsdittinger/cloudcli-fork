import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { mock } from 'node:test';

import express from 'express';

import { projectsDb } from '@/modules/database/index.js';
import { daemonClient } from '@/modules/isolation/daemon-client.js';
import { isIsolatedPath, isolationDb } from '@/modules/isolation/isolation.db.js';
import isolationRoutes from '@/modules/isolation/isolation.routes.js';
import { runTokens } from '@/modules/isolation/run-tokens.js';
import { isolationEnvFor, withIsolatedDatabase, withIsolationEnv } from '@/modules/isolation/tests/helpers.js';
import { AppError } from '@/shared/utils.js';

type Json = Record<string, any>;
type Call = (method: string, urlPath: string, body?: unknown) => Promise<{ status: number; json: Json }>;

async function withServer(role: 'admin' | 'restricted', run: (call: Call) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/isolation', (req, _res, next) => {
    (req as express.Request & { user?: unknown }).user = { id: 1, username: 'u', role };
    next();
  }, isolationRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
      return;
    }
    res.status(500).json({ success: false, error: { message: String(err) } });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const call: Call = async (method, urlPath, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Json };
  };
  try {
    await run(call);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function makeIsolatedProject(dir: string, name: string) {
  const projectPath = path.join(dir, 'isolated', name);
  fs.mkdirSync(projectPath, { recursive: true });
  const { project } = projectsDb.createProjectPath(projectPath, name);
  return { projectId: project!.project_id, projectPath };
}

test('restricted users get 403 on every isolation route', async () => {
  await withServer('restricted', async (call) => {
    for (const [method, urlPath] of [
      ['GET', '/api/isolation/status'],
      ['GET', '/api/isolation/projects/x'],
      ['PUT', '/api/isolation/projects/x'],
      ['GET', '/api/isolation/projects/x/blocked'],
      ['POST', '/api/isolation/projects/x/self-check'],
    ] as const) {
      const res = await call(method, urlPath, method === 'GET' ? undefined : {});
      assert.equal(res.status, 403, `${method} ${urlPath}`);
    }
  });
});

test('GET /status explains why isolation is unavailable', async () => {
  await withIsolatedDatabase(async () => {
    await withIsolationEnv(null, async () => {
      await withServer('admin', async (call) => {
        const res = await call('GET', '/api/isolation/status');
        assert.equal(res.status, 200);
        assert.equal(res.json.data.available, false);
        assert.match(res.json.data.reason, /CLOUDCLI_ISOLATED_ROOT/);
        assert.equal(res.json.data.daemon, null);
      });
    });
  });
});

test('GET /status reports an unreachable daemon without throwing', async () => {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      await withServer('admin', async (call) => {
        const res = await call('GET', '/api/isolation/status');
        assert.equal(res.status, 200);
        assert.equal(res.json.data.available, true);
        assert.equal(res.json.data.daemon.running, false);
        assert.match(res.json.data.daemon.reason, /Sandbox izolovaného projektu neběží/);
        assert.equal(res.json.data.claudeLogin, 'missing');
      });
    });
  });
});

test('PUT with an invalid allowlist line answers 400 with per-line errors and saves nothing', async () => {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      const { projectId } = makeIsolatedProject(dir, 'podpora');
      isolationDb.markIsolated(projectId, isolationDb.nextUid());
      const put = mock.method(daemonClient, 'putProject', async () => ({ ok: true }));
      try {
        await withServer('admin', async (call) => {
          const res = await call('PUT', `/api/isolation/projects/${projectId}`, {
            allowlist: ['ethia.cz', 'ethia.cz:99999', '# comment', '1.2.3.4'],
            tools: { channels: true, tasks: false },
          });
          assert.equal(res.status, 400);
          assert.deepEqual(res.json.errors.map((e: Json) => e.line), [2, 4]);
          for (const error of res.json.errors) assert.equal(typeof error.message, 'string');
          assert.deepEqual(isolationDb.getById(projectId)!.allowlist, []);
          assert.equal(put.mock.callCount(), 0);
        });
      } finally {
        put.mock.restore();
      }
    });
  });
});

test('PUT saves allowlist + tools and pushes the project to the daemon', async () => {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      const { projectId, projectPath } = makeIsolatedProject(dir, 'podpora');
      isolationDb.markIsolated(projectId, isolationDb.nextUid());
      const put = mock.method(daemonClient, 'putProject', async () => ({ ok: true }));
      try {
        await withServer('admin', async (call) => {
          const res = await call('PUT', `/api/isolation/projects/${projectId}`, {
            allowlist: ['ethia.cz', '*.ethia.cz', 'imap.nameserver.sk:993'],
            tools: { channels: true, tasks: false },
          });
          assert.equal(res.status, 200, JSON.stringify(res.json));
          assert.equal(res.json.data.proxySecret, undefined, 'the proxy secret never leaves the server');
          assert.deepEqual(res.json.data.allowlist, ['ethia.cz', '*.ethia.cz', 'imap.nameserver.sk:993']);
          assert.equal(res.json.data.daemonSync.ok, true);
          const saved = isolationDb.getById(projectId)!;
          assert.deepEqual(saved.tools, { channels: true, tasks: false });
          assert.equal(saved.projectPath, projectPath);
          assert.equal(put.mock.callCount(), 1);
          assert.deepEqual((put.mock.calls[0].arguments as unknown[] as [{ allowlist: string[] }])[0].allowlist, saved.allowlist);

          const got = await call('GET', `/api/isolation/projects/${projectId}`);
          assert.equal(got.status, 200);
          assert.deepEqual(got.json.data.tools, { channels: true, tasks: false });
          assert.equal(got.json.data.proxySecret, undefined);
        });
      } finally {
        put.mock.restore();
      }
    });
  });
});

test('routes 404 for a project that is not isolated', async () => {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      const plain = path.join(dir, 'plain');
      fs.mkdirSync(plain);
      const { project } = projectsDb.createProjectPath(plain, 'plain');
      await withServer('admin', async (call) => {
        assert.equal((await call('GET', `/api/isolation/projects/${project!.project_id}`)).status, 404);
        assert.equal((await call('PUT', `/api/isolation/projects/${project!.project_id}`, { allowlist: [] })).status, 404);
      });
    });
  });
});

test('self-check mints a self-check run token, passes projectDir and revokes the token afterwards', async () => {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      const { projectId, projectPath } = makeIsolatedProject(dir, 'podpora');
      isolationDb.markIsolated(projectId, isolationDb.nextUid());
      let usedToken = '';
      const check = mock.method(daemonClient, 'selfCheck', async (id: string, token: string, projectDir: string, env: Record<string, string>) => {
        usedToken = token;
        // The probe checks the env real Claude runs get, not one of its own.
        assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, token);
        assert.equal(env.CLOUDCLI_RUN_TOKEN, token);
        assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
        assert.ok(env.ANTHROPIC_BASE_URL);
        assert.equal(id, projectId);
        assert.equal(projectDir, projectPath);
        assert.equal(runTokens.resolve(token)?.purpose, 'self-check');
        return { checks: [{ id: 'no-dns', ok: true, detail: 'blocked' }] };
      });
      const put = mock.method(daemonClient, 'putProject', async () => ({ ok: true }));
      const blocked = mock.method(daemonClient, 'blocked', async () => [{ at: 'now', host: 'google.com', port: 443, kind: 'connect' }]);
      try {
        await withServer('admin', async (call) => {
          const res = await call('POST', `/api/isolation/projects/${projectId}/self-check`, {});
          assert.equal(res.status, 200);
          assert.equal(res.json.data.checks[0].id, 'no-dns');
          assert.equal(runTokens.resolve(usedToken), null);
          assert.equal(put.mock.callCount(), 1, 'the project is pushed before the check');
          const list = await call('GET', `/api/isolation/projects/${projectId}/blocked`);
          assert.equal(list.json.data[0].host, 'google.com');
        });
      } finally {
        check.mock.restore();
        put.mock.restore();
        blocked.mock.restore();
      }
    });
  });
});

test('isolationDb: uids start at 20000 and increase, markIsolated is idempotent', async () => {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      const a = makeIsolatedProject(dir, 'a');
      const b = makeIsolatedProject(dir, 'b');
      assert.equal(isolationDb.nextUid(), 20000);
      const first = isolationDb.markIsolated(a.projectId, isolationDb.nextUid());
      assert.equal(first.uid, 20000);
      assert.equal(isolationDb.nextUid(), 20001);
      const second = isolationDb.markIsolated(b.projectId, isolationDb.nextUid());
      assert.equal(second.uid, 20001);
      assert.ok(first.proxySecret.length >= 32);
      assert.notEqual(first.proxySecret, second.proxySecret);
      assert.deepEqual(first.tools, { channels: true, tasks: true });
      assert.equal(first.homeDir, path.join(dir, 'homes', a.projectId));
      // Again: same uid, same secret.
      const again = isolationDb.markIsolated(a.projectId, isolationDb.nextUid());
      assert.equal(again.uid, 20000);
      assert.equal(again.proxySecret, first.proxySecret);
      const c = makeIsolatedProject(dir, 'c');
      assert.throws(() => isolationDb.markIsolated(c.projectId, 19999));
      assert.throws(() => isolationDb.markIsolated(c.projectId, 20000), /uid/); // taken by a
      assert.equal(isolationDb.getById(c.projectId), null);
      assert.deepEqual(isolationDb.listIsolated().map((p) => p.uid).sort(), [20000, 20001]);
    });
  });
});

test('isIsolatedPath: isolated project, its subdirectories and anything under the isolated root; normal projects not', async () => {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      const iso = makeIsolatedProject(dir, 'iso');
      isolationDb.markIsolated(iso.projectId, isolationDb.nextUid());
      const plain = path.join(dir, 'workspace', 'plain');
      fs.mkdirSync(path.join(plain, 'sub'), { recursive: true });
      projectsDb.createProjectPath(plain, 'plain');
      fs.mkdirSync(path.join(iso.projectPath, 'sub'));
      fs.symlinkSync(iso.projectPath, path.join(dir, 'link-to-iso'));

      assert.equal(isIsolatedPath(iso.projectPath), true);
      assert.equal(isIsolatedPath(`${iso.projectPath}/`), true);
      assert.equal(isIsolatedPath(path.join(iso.projectPath, 'sub')), true);
      assert.equal(isIsolatedPath(path.join(dir, 'link-to-iso')), true, 'symlink to an isolated project');
      assert.equal(isIsolatedPath(path.join(dir, 'isolated', 'unregistered')), true, 'fail closed under the isolated root');
      assert.equal(isIsolatedPath(plain), false);
      assert.equal(isIsolatedPath(path.join(plain, 'sub')), false);
      assert.equal(isIsolatedPath(''), false);

      assert.equal(isolationDb.getByPath(path.join(dir, 'link-to-iso'))?.projectId, iso.projectId);
      assert.equal(isolationDb.getByPath(path.join(iso.projectPath, 'sub'))?.projectId, iso.projectId);
      assert.equal(isolationDb.getByPath(plain), null);
    });
  });
});

test('isIsolatedPath still true for an isolated project when isolation env is gone (fail closed)', async () => {
  await withIsolatedDatabase(async (dir) => {
    let projectPath = '';
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      const iso = makeIsolatedProject(dir, 'iso');
      projectPath = iso.projectPath;
      isolationDb.markIsolated(iso.projectId, isolationDb.nextUid());
    });
    await withIsolationEnv(null, async () => {
      assert.equal(isIsolatedPath(projectPath), true);
    });
  });
});

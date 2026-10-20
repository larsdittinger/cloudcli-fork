import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startDaemon } from '../daemon/daemon.js';
import { SELF_CHECK_IDS_STATIC } from '../daemon/self-check.js';

const TOKEN = 'test-token';

test('self-check reports each id (real probe script, dev mode)', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbxc-')));
  const root = path.join(tmp, 'isolated');
  fs.mkdirSync(path.join(root, 'proj'), { recursive: true });
  fs.mkdirSync(path.join(root, 'other'));
  const daemon = await startDaemon({
    token: TOKEN, isolationDir: path.join(tmp, 'iso'), dev: true, isolatedRoot: root, isolatedHomes: path.join(tmp, 'homes'),
    statOwner: () => 20001,
  });
  try {
    const call = (method: string, p: string, body: unknown) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = http.request({ socketPath: daemon.socketPath, method, path: p, headers: { Authorization: `Bearer ${TOKEN}` } }, (res) => {
          let t = '';
          res.on('data', (c) => (t += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(t) }));
        });
        req.on('error', reject);
        req.end(JSON.stringify(body));
      });
    await call('PUT', '/v1/projects/proj', { uid: 20001, name: 'P', allowlist: ['example.org'], proxySecret: 'sec' });
    const res = await call('POST', '/v1/projects/proj/self-check', { runToken: 'rt', projectDir: path.join(root, 'proj') });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const ids: string[] = res.body.checks.map((c: { id: string }) => c.id);
    for (const id of [...SELF_CHECK_IDS_STATIC, 'proxy-allows:example.org']) assert.ok(ids.includes(id), `missing ${id}`);
    for (const check of res.body.checks) {
      assert.equal(typeof check.ok, 'boolean');
      assert.equal(typeof check.detail, 'string');
    }
    const byId = Object.fromEntries(res.body.checks.map((c: { id: string; ok: boolean }) => [c.id, c.ok]));
    assert.equal(byId['env-clean'], true); // only run token and proxy vars
    assert.equal(byId['no-workspace'], true);

    // The env the app really runs Claude with (buildSandboxEnv) is what the probe checks.
    const appEnv = {
      PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/ignored', ANTHROPIC_BASE_URL: 'http://127.0.0.1:7701/anthropic',
      CLAUDE_CODE_OAUTH_TOKEN: 'rt', CLOUDCLI_RUN_TOKEN: 'rt', ENABLE_CLAUDEAI_MCP_SERVERS: 'false', NO_PROXY: '127.0.0.1,localhost',
      https_proxy: 'http://proj:sec@127.0.0.1:7702', http_proxy: 'http://proj:sec@127.0.0.1:7702',
    };
    const envClean = async (env: Record<string, unknown>) => {
      const r = await call('POST', '/v1/projects/proj/self-check', { runToken: 'rt', projectDir: path.join(root, 'proj'), env });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.checks.find((c: { id: string }) => c.id === 'env-clean') as { ok: boolean; detail: string };
    };
    assert.equal((await envClean(appEnv)).ok, true, 'the real Claude env passes');
    const leaked = await envClean({ ...appEnv, ANTHROPIC_API_KEY: 'sk-ant-api03-leak' });
    assert.equal(leaked.ok, false);
    assert.match(leaked.detail, /ANTHROPIC_API_KEY/);
    const realLogin = await envClean({ ...appEnv, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-the-owners-login' });
    assert.equal(realLogin.ok, false, 'the OAuth variable may only carry the run token');
    assert.match(realLogin.detail, /CLAUDE_CODE_OAUTH_TOKEN/);
    const hidden = await envClean({ ...appEnv, LANG_EXTRA: 'sk-ant-oat01-hidden' });
    assert.equal(hidden.ok, false, 'a Claude token under any name');
    for (const bad of [{ X: 1 }, ['A=B'], 'A=B']) {
      const r = await call('POST', '/v1/projects/proj/self-check', { runToken: 'rt', projectDir: path.join(root, 'proj'), env: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }

    // Agent-writable shell startup files must not be able to forge the result.
    const home = path.join(tmp, 'homes', 'proj');
    fs.mkdirSync(home, { recursive: true });
    const fake = `echo '{"checks":[{"id":"fake","ok":true,"detail":"forged"}]}'; exit 0\n`;
    for (const f of ['.bash_profile', '.profile', '.bashrc', '.bash_login']) fs.writeFileSync(path.join(home, f), fake);
    const again = await call('POST', '/v1/projects/proj/self-check', { runToken: 'rt', projectDir: path.join(root, 'proj') });
    assert.equal(again.status, 200);
    assert.equal(again.body.checks.some((c: { id: string }) => c.id === 'fake'), false);
    assert.ok(again.body.checks.some((c: { id: string }) => c.id === 'env-clean'));
  } finally {
    await daemon.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

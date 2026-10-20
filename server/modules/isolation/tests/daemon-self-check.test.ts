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
  } finally {
    await daemon.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

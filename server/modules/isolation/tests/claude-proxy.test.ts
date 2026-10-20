import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { appConfigDb } from '@/modules/database/index.js';
import { CLAUDE_LOGIN_MISSING, claudeUpstreamHealth, createClaudeProxy, ISOLATION_CLAUDE_TOKEN_KEY } from '@/modules/isolation/claude-proxy.js';
import { runTokens } from '@/modules/isolation/run-tokens.js';
import { createSandboxApiApp, startSandboxApiServer, type SandboxApiServer } from '@/modules/isolation/sandbox-api.server.js';
import { withIsolatedDatabase } from '@/modules/isolation/tests/helpers.js';

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

let tmp: string;
let upstream: http.Server;
let upstreamUrl: string;
const seen: Seen[] = [];
let releaseSecondEvent: () => void = () => {};

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-')));
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url === '/v1/models/denied') {
        // Echoes the credential it got, as a careless upstream might: the proxy must not keep it.
        res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: `OAuth token has been revoked (${String(req.headers.authorization)})` },
        }));
        return;
      }
      if (/^\/v1\/messages(\?|$)/.test(req.url ?? '')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('event: one\ndata: {"n":1}\n\n');
        // The second event only goes out once the client has seen the first: a buffering proxy deadlocks here.
        new Promise<void>((resolve) => { releaseSecondEvent = resolve; }).then(() => {
          res.end('event: two\ndata: {"n":2}\n\n');
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
});

after(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function withSandboxApi(
  proxyOptions: Parameters<typeof createClaudeProxy>[0],
  run: (socketPath: string) => Promise<void>,
): Promise<void> {
  const socketPath = path.join(tmp, `m${Math.random().toString(16).slice(2, 8)}.sock`);
  const server: SandboxApiServer = await startSandboxApiServer(socketPath, createSandboxApiApp({ claudeProxy: createClaudeProxy(proxyOptions) }));
  try {
    await run(socketPath);
  } finally {
    await server.close();
  }
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string; chunks: string[] };

function call(socketPath: string, method: string, urlPath: string, headers: Record<string, string> = {}, body?: string, onChunk?: (chunk: string) => void): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: urlPath, headers }, (res) => {
      const chunks: string[] = [];
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        chunks.push(chunk);
        onChunk?.(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: chunks.join(''), chunks }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const SETUP_TOKEN = 'sk-ant-oat01-setup-token';

test('without a run token the proxy answers 401 and forwards nothing', async () => {
  const before = seen.length;
  await withSandboxApi({ upstreamUrl, storedToken: () => SETUP_TOKEN }, async (socketPath) => {
    const res = await call(socketPath, 'POST', '/anthropic/v1/messages?beta=true', { 'Content-Type': 'application/json' }, '{}');
    assert.equal(res.status, 401);
    const wrong = await call(socketPath, 'POST', '/anthropic/v1/messages', { Authorization: 'Bearer not-a-run-token' }, '{}');
    assert.equal(wrong.status, 401);
  });
  assert.equal(seen.length, before);
});

test('token revoked on exit: the proxy rejects it with 401', async () => {
  const token = runTokens.mint({ projectId: 'p1', sessionId: 's1', purpose: 'claude' });
  runTokens.revoke(token);
  const before = seen.length;
  await withSandboxApi({ upstreamUrl, storedToken: () => SETUP_TOKEN }, async (socketPath) => {
    const res = await call(socketPath, 'POST', '/anthropic/v1/messages', { Authorization: `Bearer ${token}` }, '{}');
    assert.equal(res.status, 401);
  });
  assert.equal(seen.length, before);
});

test('valid run token: upstream gets the setup token, no x-api-key, beta kept, SSE streamed in parts', async () => {
  const token = runTokens.mint({ projectId: 'p1', sessionId: 's1', purpose: 'claude' });
  try {
    await withSandboxApi({ upstreamUrl, storedToken: () => SETUP_TOKEN }, async (socketPath) => {
      const guard = setTimeout(() => releaseSecondEvent(), 5000); // never hang: a buffered reply then fails the chunk assertion
      const res = await call(
        socketPath,
        'POST',
        '/anthropic/v1/messages?beta=true',
        {
          Authorization: `Bearer ${token}`,
          'x-api-key': 'leak-me',
          'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
          'Content-Type': 'application/json',
        },
        '{"model":"x"}',
        (chunk) => {
          if (chunk.includes('"n":1')) releaseSecondEvent();
        },
      );
      clearTimeout(guard);
      assert.equal(res.status, 200);
      assert.match(String(res.headers['content-type']), /text\/event-stream/);
      assert.ok(res.chunks.length >= 2, `expected the stream in parts, got ${JSON.stringify(res.chunks)}`);
      assert.ok(res.chunks[0].includes('"n":1') && !res.chunks[0].includes('"n":2'));
      assert.ok(res.body.includes('"n":2'));

      const upstreamSaw = seen.at(-1)!;
      assert.equal(upstreamSaw.method, 'POST');
      assert.equal(upstreamSaw.url, '/v1/messages?beta=true');
      assert.equal(upstreamSaw.headers.authorization, `Bearer ${SETUP_TOKEN}`);
      assert.ok(!JSON.stringify(upstreamSaw.headers).includes(token), 'run token must not reach upstream');
      assert.equal(upstreamSaw.headers['x-api-key'], undefined);
      assert.match(String(upstreamSaw.headers['anthropic-beta']), /claude-code-20250219/);
      assert.match(String(upstreamSaw.headers['anthropic-beta']), /oauth-2025-04-20/);
      assert.equal(upstreamSaw.body, '{"model":"x"}');

      const hello = await call(socketPath, 'HEAD', '/anthropic/api/hello', { Authorization: `Bearer ${token}` });
      assert.equal(hello.status, 200);
      assert.equal(seen.at(-1)!.url, '/api/hello');
    });
  } finally {
    runTokens.revoke(token);
  }
});

test('paths outside the Messages API are refused (no account endpoints with the owner token)', async () => {
  const token = runTokens.mint({ projectId: 'p1', sessionId: 's1', purpose: 'claude' });
  const before = seen.length;
  try {
    await withSandboxApi({ upstreamUrl, storedToken: () => SETUP_TOKEN }, async (socketPath) => {
      const res = await call(socketPath, 'POST', '/anthropic/api/oauth/claude_cli/create_api_key', { Authorization: `Bearer ${token}` }, '{}');
      assert.equal(res.status, 403);
      const traversal = await call(socketPath, 'GET', '/anthropic/v1/../api/oauth/profile', { Authorization: `Bearer ${token}` });
      assert.notEqual(traversal.status, 200);
    });
  } finally {
    runTokens.revoke(token);
  }
  assert.equal(seen.length, before);
});

test('only inference paths are forwarded, with the setup token and the credentials fallback alike; refusals logged once per path', async () => {
  const credentialsPath = path.join(tmp, 'valid-narrow.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'live-access', expiresAt: Date.now() + 3_600_000 } }));
  const token = runTokens.mint({ projectId: 'p1', sessionId: 's1', purpose: 'claude' });
  const refused = [
    '/anthropic/v1/mcp_servers', '/anthropic/v1/mcp_servers?limit=1000', '/anthropic/v1/sessions', '/anthropic/v1/files',
    '/anthropic/v1/messages/batches', '/anthropic/v1/messagesx', '/anthropic/v1/models/a/b', '/anthropic/v1/', '/anthropic/api/oauth/profile',
  ];
  const allowed = ['/anthropic/v1/models', '/anthropic/v1/models/claude-opus-5-5', '/anthropic/api/hello', '/anthropic/v1/models?limit=5'];
  try {
    for (const tokenSource of [{ storedToken: () => SETUP_TOKEN }, { storedToken: () => null, credentialsPath }]) {
      const logged: string[] = [];
      await withSandboxApi({ upstreamUrl, ...tokenSource, onRefused: (pathname: string) => logged.push(pathname) }, async (socketPath) => {
        const before = seen.length;
        for (const urlPath of [...refused, '/anthropic/v1/files']) {
          const res = await call(socketPath, 'GET', urlPath, { Authorization: `Bearer ${token}` });
          assert.equal(res.status, 403, urlPath);
        }
        assert.equal(seen.length, before, 'nothing refused reaches Anthropic');
        assert.equal(logged.filter((entry) => entry === '/v1/files').length, 1, 'one log line per path');
        for (const urlPath of allowed) {
          const res = await call(socketPath, 'GET', urlPath, { Authorization: `Bearer ${token}` });
          assert.equal(res.status, 200, urlPath);
        }
        const counted = await call(socketPath, 'POST', '/anthropic/v1/messages/count_tokens?beta=true', { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, '{}');
        assert.equal(counted.status, 200);
        assert.equal(seen.length, before + allowed.length + 1);
      });
    }
  } finally {
    runTokens.revoke(token);
  }
});

test('exec run tokens (schedule scripts) cannot use the Claude API', async () => {
  const token = runTokens.mint({ projectId: 'p1', sessionId: '', purpose: 'exec' });
  const before = seen.length;
  try {
    await withSandboxApi({ upstreamUrl, storedToken: () => SETUP_TOKEN }, async (socketPath) => {
      const res = await call(socketPath, 'GET', '/anthropic/v1/models', { Authorization: `Bearer ${token}` });
      assert.equal(res.status, 403);
    });
  } finally {
    runTokens.revoke(token);
  }
  assert.equal(seen.length, before);
});

test('no setup token and expired credentials.json: 401 with the sandbox-token hint', async () => {
  const credentialsPath = path.join(tmp, 'expired.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'old', expiresAt: Date.now() - 1000 } }));
  const token = runTokens.mint({ projectId: 'p1', sessionId: 's1', purpose: 'claude' });
  const before = seen.length;
  try {
    await withSandboxApi({ upstreamUrl, storedToken: () => null, credentialsPath }, async (socketPath) => {
      const res = await call(socketPath, 'POST', '/anthropic/v1/messages', { Authorization: `Bearer ${token}` }, '{}');
      assert.equal(res.status, 401);
      assert.ok(res.body.includes(CLAUDE_LOGIN_MISSING), res.body);
    });
    await withSandboxApi({ upstreamUrl, storedToken: () => null, credentialsPath: path.join(tmp, 'missing.json') }, async (socketPath) => {
      const res = await call(socketPath, 'POST', '/anthropic/v1/messages', { Authorization: `Bearer ${token}` }, '{}');
      assert.equal(res.status, 401);
      assert.ok(res.body.includes(CLAUDE_LOGIN_MISSING));
    });
  } finally {
    runTokens.revoke(token);
  }
  assert.equal(seen.length, before);
});

test('no setup token but a valid credentials.json: its access token is used', async () => {
  const credentialsPath = path.join(tmp, 'valid.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'live-access', refreshToken: 'never-forwarded', expiresAt: Date.now() + 3_600_000 } }));
  const token = runTokens.mint({ projectId: 'p1', sessionId: 's1', purpose: 'claude' });
  try {
    await withSandboxApi({ upstreamUrl, storedToken: () => null, credentialsPath }, async (socketPath) => {
      const res = await call(socketPath, 'GET', '/anthropic/v1/models', { Authorization: `Bearer ${token}` });
      assert.equal(res.status, 200);
      assert.equal(seen.at(-1)!.headers.authorization, 'Bearer live-access');
    });
  } finally {
    runTokens.revoke(token);
  }
});

test('default token source is app_config.isolation_claude_token', async () => {
  await withIsolatedDatabase(async () => {
    appConfigDb.set(ISOLATION_CLAUDE_TOKEN_KEY, 'sk-ant-oat01-from-db');
    const token = runTokens.mint({ projectId: 'p1', sessionId: 's1', purpose: 'claude' });
    try {
      await withSandboxApi({ upstreamUrl, credentialsPath: path.join(tmp, 'missing.json') }, async (socketPath) => {
        const res = await call(socketPath, 'GET', '/anthropic/v1/models', { Authorization: `Bearer ${token}` });
        assert.equal(res.status, 200);
        assert.equal(seen.at(-1)!.headers.authorization, 'Bearer sk-ant-oat01-from-db');
      });
    } finally {
      runTokens.revoke(token);
    }
  });
});

test('main.sock: socket mode 0660, MCP paths need a run token, everything else 404', async () => {
  const token = runTokens.mint({ projectId: 'p1', sessionId: 's1', purpose: 'claude' });
  try {
    await withSandboxApi({ upstreamUrl, storedToken: () => SETUP_TOKEN }, async (socketPath) => {
      assert.equal(fs.statSync(socketPath).mode & 0o777, 0o660);
      for (const mcp of ['/api/channels-mcp/tools/channels_reply', '/api/tasks-mcp/tools/tasks_log']) {
        const noToken = await call(socketPath, 'POST', mcp, { 'Content-Type': 'application/json' }, '{}');
        assert.equal(noToken.status, 401, mcp);
        const withToken = await call(socketPath, 'POST', mcp, { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, '{}');
        assert.notEqual(withToken.status, 401, mcp);
      }
      for (const other of ['/api/auth/status', '/api/projects', '/health', '/']) {
        const res = await call(socketPath, 'GET', other, { Authorization: `Bearer ${token}` });
        assert.equal(res.status, 404, other);
      }
      const getMcp = await call(socketPath, 'GET', '/api/channels-mcp/tools/channels_reply', { Authorization: `Bearer ${token}` });
      assert.equal(getMcp.status, 404);
    });
  } finally {
    runTokens.revoke(token);
  }
});

test('main.sock replaces a stale socket file at startup', async () => {
  const socketPath = path.join(tmp, 'stale.sock');
  fs.writeFileSync(socketPath, 'left over');
  const server = await startSandboxApiServer(socketPath, createSandboxApiApp({ claudeProxy: createClaudeProxy({ upstreamUrl, storedToken: () => SETUP_TOKEN }) }));
  try {
    const res = await call(socketPath, 'GET', '/nothing');
    assert.equal(res.status, 404);
  } finally {
    await server.close();
  }
  assert.equal(fs.existsSync(socketPath), false);
});

test('the proxy remembers its last success and last upstream error per token, without the token', async () => {
  const token = runTokens.mint({ projectId: 'p1', sessionId: 's1', purpose: 'claude' });
  claudeUpstreamHealth.reset();
  try {
    await withSandboxApi({ upstreamUrl, storedToken: () => SETUP_TOKEN }, async (socketPath) => {
      assert.deepEqual(claudeUpstreamHealth.forToken(SETUP_TOKEN), {});
      const ok = await call(socketPath, 'GET', '/anthropic/v1/models', { Authorization: `Bearer ${token}` });
      assert.equal(ok.status, 200);
      const okAt = claudeUpstreamHealth.forToken(SETUP_TOKEN).okAt;
      assert.ok(okAt && Date.parse(okAt) > Date.now() - 60_000);
      assert.equal(claudeUpstreamHealth.forToken(SETUP_TOKEN).error, undefined);

      const denied = await call(socketPath, 'GET', '/anthropic/v1/models/denied', { Authorization: `Bearer ${token}` });
      assert.equal(denied.status, 401);
      assert.match(denied.body, /revoked/, 'the CLI still gets the upstream answer');
      const health = claudeUpstreamHealth.forToken(SETUP_TOKEN);
      assert.equal(health.okAt, okAt);
      assert.equal(health.error?.status, 401);
      assert.match(health.error?.message ?? '', /OAuth token has been revoked/);
      assert.ok(!JSON.stringify(health).includes(SETUP_TOKEN), 'the echoed token is redacted');
      assert.ok((health.error?.message.length ?? 0) <= 300);
      assert.deepEqual(claudeUpstreamHealth.forToken('sk-ant-oat01-another-token'), {}, 'another token has its own record');
    });

    // Anthropic unreachable: an error without an HTTP status.
    await withSandboxApi({ upstreamUrl: 'http://127.0.0.1:9', storedToken: () => SETUP_TOKEN }, async (socketPath) => {
      const res = await call(socketPath, 'GET', '/anthropic/v1/models', { Authorization: `Bearer ${token}` });
      assert.equal(res.status, 502);
      const health = claudeUpstreamHealth.forToken(SETUP_TOKEN);
      assert.equal(health.error?.status, null);
      assert.match(health.error?.message ?? '', /unreachable/);
    });
  } finally {
    runTokens.revoke(token);
    claudeUpstreamHealth.reset();
  }
});

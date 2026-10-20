import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { mock } from 'node:test';

import express from 'express';

import { appConfigDb } from '@/modules/database/index.js';
import { claudeUpstreamHealth, ISOLATION_CLAUDE_TOKEN_KEY } from '@/modules/isolation/claude-proxy.js';
import {
  extractSetupToken,
  ISOLATION_CLAUDE_TOKEN_SET_AT_KEY,
  verifyClaudeToken,
} from '@/modules/isolation/claude-login.js';
import isolationRoutes from '@/modules/isolation/isolation.routes.js';
import { withIsolatedDatabase } from '@/modules/isolation/tests/helpers.js';
import { AppError } from '@/shared/utils.js';

type Json = Record<string, any>;

// Real setup-tokens are 108 characters; the extraction refuses suspiciously short ones (cut or wrapped).
const TOKEN = `sk-ant-oat01-${'A1b2_C3d4-'.repeat(9)}WXYZ`;
const OTHER = `sk-ant-oat01-${'Zz9_'.repeat(20)}QRST`;
const SETUP_OUTPUT = `✓ Long-lived authentication token created successfully!\n\nYour OAuth token (valid for 1 year):\n\n${TOKEN}\n\nStore this token securely. You won't be able to see it again.\n\nUse this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>\n`;

const errorCode = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof AppError, String(error));
    assert.ok(!error.message.includes('sk-ant-oat01-A1b2'), 'no token in the error');
    return error.code;
  }
  assert.fail('expected an error');
};

test('extractSetupToken takes the token out of the whole `claude setup-token` output', () => {
  assert.equal(extractSetupToken(SETUP_OUTPUT), TOKEN);
  assert.equal(extractSetupToken(`  ${TOKEN}  `), TOKEN);
  assert.equal(extractSetupToken(`${TOKEN}\nexport CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`), TOKEN, 'the same token twice is one token');
});

test('extractSetupToken refuses no token, two different tokens and a cut token', () => {
  assert.equal(errorCode(() => extractSetupToken('nothing here')), 'NO_TOKEN');
  assert.equal(errorCode(() => extractSetupToken('')), 'NO_TOKEN');
  assert.equal(errorCode(() => extractSetupToken(`${TOKEN}\n${OTHER}`)), 'MULTIPLE_TOKENS');
  assert.equal(errorCode(() => extractSetupToken('sk-ant-oat01-short')), 'TOKEN_TOO_SHORT');
});

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(reply: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const impl = async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return reply(call);
  };
  return { calls, impl: impl as typeof fetch };
}

const anthropicJson = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('verifyClaudeToken counts tokens with the OAuth headers and classifies the answer', async () => {
  const ok = fakeFetch(() => anthropicJson(200, { input_tokens: 8 }));
  assert.deepEqual(await verifyClaudeToken(TOKEN, { fetchImpl: ok.impl }), { result: 'ok', status: 200 });
  const { url, init } = ok.calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages/count_tokens');
  assert.equal(init.method, 'POST');
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(JSON.parse(String(init.body)).model, 'claude-haiku-4-5');

  const rejected = fakeFetch(() => anthropicJson(401, { type: 'error', error: { type: 'authentication_error', message: `OAuth access token is invalid: ${TOKEN}` } }));
  const no = await verifyClaudeToken(TOKEN, { fetchImpl: rejected.impl });
  assert.equal(no.result, 'rejected');
  assert.equal(no.status, 401);
  assert.match(no.message ?? '', /OAuth access token is invalid/);
  assert.ok(!JSON.stringify(no).includes(TOKEN), 'a token echoed by the upstream is redacted');

  const forbidden = fakeFetch(() => anthropicJson(403, { type: 'error', error: { type: 'permission_error', message: 'nope' } }));
  assert.equal((await verifyClaudeToken(TOKEN, { fetchImpl: forbidden.impl })).result, 'rejected');

  const down = fakeFetch(() => { throw new TypeError('fetch failed'); });
  const unreachable = await verifyClaudeToken(TOKEN, { fetchImpl: down.impl });
  assert.equal(unreachable.result, 'unverified');
  assert.equal(unreachable.status, undefined);
  assert.match(unreachable.message ?? '', /fetch failed/);

  // Overloaded, rate limited, retired model…: says nothing about the token.
  const overloaded = fakeFetch(() => anthropicJson(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
  const maybe = await verifyClaudeToken(TOKEN, { fetchImpl: overloaded.impl });
  assert.equal(maybe.result, 'unverified');
  assert.equal(maybe.status, 529);
});

type Call = (method: string, urlPath: string, body?: unknown) => Promise<{ status: number; json: Json; text: string }>;

async function withServer(run: (call: Call) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/isolation', (req, _res, next) => {
    (req as express.Request & { user?: unknown }).user = { id: 1, username: 'u', role: 'admin' };
    next();
  }, isolationRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    res.status(500).json({ success: false, error: { message: String(err) } });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const call: Call = async (method, urlPath, body) => {
    const response = await realFetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: JSON.parse(text) as Json, text };
  };
  try {
    await run(call);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const realFetch = globalThis.fetch;

/**
 * A fresh DB and HOME (no ~/.claude/.credentials.json unless the test writes one), Anthropic answered by `anthropic`,
 * and every console line captured so the test can prove the token never reaches the log.
 */
async function withLoginEnv(
  anthropic: (call: FetchCall) => Response | Promise<Response>,
  run: (ctx: { dir: string; anthropicCalls: FetchCall[]; logged: () => string; call: Call }) => Promise<void>,
): Promise<void> {
  await withIsolatedDatabase(async (dir) => {
    const previousHome = process.env.HOME;
    process.env.HOME = dir;
    const anthropicCalls: FetchCall[] = [];
    const fetchMock = mock.method(globalThis, 'fetch', async (url: string | URL | Request, init: RequestInit = {}) => {
      if (String(url).startsWith('https://api.anthropic.com/')) {
        const call = { url: String(url), init };
        anthropicCalls.push(call);
        return anthropic(call);
      }
      return realFetch(url, init);
    });
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      mock.method(console, level, (...args: unknown[]) => { lines.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')); }));
    claudeUpstreamHealth.reset();
    try {
      await withServer((call) => run({ dir, anthropicCalls, logged: () => lines.join('\n'), call }));
    } finally {
      for (const spy of spies) spy.mock.restore();
      fetchMock.mock.restore();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      claudeUpstreamHealth.reset();
    }
  });
}

const okAnthropic = () => anthropicJson(200, { input_tokens: 8 });

test('GET without any login: source missing, nothing else', async () => {
  await withLoginEnv(okAnthropic, async ({ call, anthropicCalls }) => {
    const res = await call('GET', '/api/isolation/claude-login');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, {
      source: 'missing',
      tokenSetAt: null,
      tokenLast4: null,
      credentialsExpiresAt: null,
      lastCheck: null,
      lastUpstream: {},
    });
    assert.equal(anthropicCalls.length, 0, 'GET never calls Anthropic');
  });
});

test('PUT verifies and saves the token; responses and logs never carry it', async () => {
  await withLoginEnv(okAnthropic, async ({ call, anthropicCalls, logged }) => {
    const res = await call('PUT', '/api/isolation/claude-login', { text: SETUP_OUTPUT });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.data.source, 'setup-token');
    assert.equal(res.json.data.tokenLast4, 'WXYZ');
    assert.ok(Date.parse(res.json.data.tokenSetAt) > Date.now() - 60_000);
    assert.equal(res.json.data.lastCheck.ok, true);
    assert.equal(res.json.data.lastCheck.status, 200);
    assert.equal(appConfigDb.get(ISOLATION_CLAUDE_TOKEN_KEY), TOKEN);
    assert.equal((anthropicCalls[0].init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);

    const got = await call('GET', '/api/isolation/claude-login');
    assert.equal(got.json.data.source, 'setup-token');
    assert.equal(got.json.data.lastCheck.ok, true);
    for (const text of [res.text, got.text, logged()]) {
      assert.ok(!text.includes(TOKEN), 'token leaked');
      assert.ok(!text.includes(TOKEN.slice(13, 40)), 'part of the token leaked');
    }
  });
});

test('PUT with a token Anthropic refuses: 400, nothing saved, the error has no token', async () => {
  const refuse = () => anthropicJson(401, { type: 'error', error: { type: 'authentication_error', message: `OAuth access token is invalid. (${TOKEN})` } });
  await withLoginEnv(refuse, async ({ call, logged }) => {
    appConfigDb.set(ISOLATION_CLAUDE_TOKEN_KEY, OTHER);
    const res = await call('PUT', '/api/isolation/claude-login', { text: SETUP_OUTPUT, force: true });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'TOKEN_REJECTED');
    assert.equal(res.json.error.details.status, 401);
    assert.match(res.json.error.message, /401/);
    assert.equal(appConfigDb.get(ISOLATION_CLAUDE_TOKEN_KEY), OTHER, 'a refused token never replaces the current one, not even with force');
    assert.ok(!res.text.includes(TOKEN) && !logged().includes(TOKEN));
  });
});

test('PUT when Anthropic cannot be reached: 502 unless forced, then saved as unverified', async () => {
  await withLoginEnv(() => { throw new TypeError('fetch failed'); }, async ({ call, logged }) => {
    const res = await call('PUT', '/api/isolation/claude-login', { text: SETUP_OUTPUT });
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, 'VERIFY_UNAVAILABLE');
    assert.equal(appConfigDb.get(ISOLATION_CLAUDE_TOKEN_KEY), null);

    const forced = await call('PUT', '/api/isolation/claude-login', { text: SETUP_OUTPUT, force: true });
    assert.equal(forced.status, 200, forced.text);
    assert.equal(forced.json.data.source, 'setup-token');
    assert.equal(forced.json.data.lastCheck.ok, false);
    assert.equal(forced.json.data.lastCheck.unverified, true);
    assert.match(forced.json.data.lastCheck.error, /fetch failed/);
    assert.equal(appConfigDb.get(ISOLATION_CLAUDE_TOKEN_KEY), TOKEN);
    assert.ok(![res.text, forced.text, logged()].some((text) => text.includes(TOKEN)));
  });
});

test('PUT refuses bad input before calling Anthropic', async () => {
  await withLoginEnv(okAnthropic, async ({ call, anthropicCalls }) => {
    assert.equal((await call('PUT', '/api/isolation/claude-login', {})).json.error.code, 'INVALID_REQUEST');
    assert.equal((await call('PUT', '/api/isolation/claude-login', { text: 'hello' })).json.error.code, 'NO_TOKEN');
    const two = await call('PUT', '/api/isolation/claude-login', { text: `${TOKEN} ${OTHER}` });
    assert.equal(two.status, 400);
    assert.equal(two.json.error.code, 'MULTIPLE_TOKENS');
    assert.equal((await call('PUT', '/api/isolation/claude-login', { text: 'x'.repeat(70_000) })).status, 400);
    assert.equal(anthropicCalls.length, 0);
  });
});

test('a token written by the hub (no set_at) shows without a date; the last check belongs to one token', async () => {
  let status = 200;
  await withLoginEnv(() => anthropicJson(status, status === 200 ? { input_tokens: 8 } : { type: 'error', error: { type: 'authentication_error', message: 'revoked' } }), async ({ call }) => {
    appConfigDb.set(ISOLATION_CLAUDE_TOKEN_KEY, TOKEN);
    const got = await call('GET', '/api/isolation/claude-login');
    assert.equal(got.json.data.source, 'setup-token');
    assert.equal(got.json.data.tokenSetAt, null);
    assert.equal(got.json.data.tokenLast4, 'WXYZ');

    status = 401;
    const checked = await call('POST', '/api/isolation/claude-login/check', {});
    assert.equal(checked.status, 200, checked.text);
    assert.equal(checked.json.data.lastCheck.ok, false);
    assert.equal(checked.json.data.lastCheck.status, 401);
    assert.match(checked.json.data.lastCheck.error, /revoked/);
    assert.ok(!checked.text.includes(TOKEN));

    // The hub replaces the token: the old check says nothing about the new one.
    appConfigDb.set(ISOLATION_CLAUDE_TOKEN_KEY, OTHER);
    const after = await call('GET', '/api/isolation/claude-login');
    assert.equal(after.json.data.tokenLast4, 'QRST');
    assert.equal(after.json.data.lastCheck, null);
  });
});

test('DELETE removes the token and set_at; the app login is the fallback with its expiry', async () => {
  await withLoginEnv(okAnthropic, async ({ call, dir }) => {
    const expiresAt = Date.now() + 3 * 3_600_000;
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'live-access-token-of-the-app', expiresAt } }));
    await call('PUT', '/api/isolation/claude-login', { text: SETUP_OUTPUT });
    assert.ok(appConfigDb.get(ISOLATION_CLAUDE_TOKEN_SET_AT_KEY));

    const res = await call('DELETE', '/api/isolation/claude-login');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.data.source, 'credentials');
    assert.equal(res.json.data.tokenLast4, null);
    assert.equal(res.json.data.tokenSetAt, null);
    assert.equal(res.json.data.credentialsExpiresAt, new Date(expiresAt).toISOString());
    assert.ok(!appConfigDb.get(ISOLATION_CLAUDE_TOKEN_KEY));
    assert.ok(!appConfigDb.get(ISOLATION_CLAUDE_TOKEN_SET_AT_KEY));
    assert.ok(!res.text.includes('live-access-token-of-the-app'));

    const checked = await call('POST', '/api/isolation/claude-login/check', {});
    assert.equal(checked.json.data.lastCheck.ok, true);
  });
});

test('POST /check without any login answers 409', async () => {
  await withLoginEnv(okAnthropic, async ({ call, anthropicCalls }) => {
    const res = await call('POST', '/api/isolation/claude-login/check', {});
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'NO_CLAUDE_LOGIN');
    assert.equal(anthropicCalls.length, 0);
  });
});

test('GET reports what the proxy last saw with the current token', async () => {
  await withLoginEnv(okAnthropic, async ({ call }) => {
    appConfigDb.set(ISOLATION_CLAUDE_TOKEN_KEY, TOKEN);
    claudeUpstreamHealth.recordOk(TOKEN);
    claudeUpstreamHealth.recordError(TOKEN, 401, 'OAuth token has been revoked.');
    const got = await call('GET', '/api/isolation/claude-login');
    assert.ok(got.json.data.lastUpstream.okAt);
    assert.equal(got.json.data.lastUpstream.error.status, 401);
    assert.equal(got.json.data.lastUpstream.error.message, 'OAuth token has been revoked.');

    // Saving another token starts from a clean record.
    const saved = await call('PUT', '/api/isolation/claude-login', { text: OTHER });
    assert.deepEqual(saved.json.data.lastUpstream, {});
  });
});

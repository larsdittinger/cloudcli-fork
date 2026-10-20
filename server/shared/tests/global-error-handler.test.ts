import assert from 'node:assert/strict';
import http from 'node:http';
import test, { mock } from 'node:test';

import express from 'express';

import { AppError, globalErrorHandler } from '@/shared/utils.js';

const SECRET = 'sk-ant-oat01-do-not-log-me-0123456789';

async function withApp(run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.put('/api/thing', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/app-error', () => { throw new AppError('Nope.', { code: 'NOPE', statusCode: 409 }); });
  app.get('/api/crash', () => { throw new Error('boom'); });
  app.use(globalErrorHandler);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function captureConsole() {
  const lines: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    mock.method(console, level, (...args: unknown[]) => {
      lines.push(args.map((arg) => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return `${arg.stack} ${JSON.stringify(arg)} ${JSON.stringify(Object.entries(arg))}`;
        return JSON.stringify(arg);
      }).join(' '));
    }));
  return { text: () => lines.join('\n'), restore: () => spies.forEach((spy) => spy.mock.restore()) };
}

test('malformed JSON: 400 INVALID_JSON and the raw body (a pasted token, a password) never reaches the log', async () => {
  const consoleCapture = captureConsole();
  try {
    await withApp(async (base) => {
      const res = await fetch(`${base}/api/thing?x=1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: `{"text": "${SECRET}", oops}`,
      });
      assert.equal(res.status, 400);
      const body = await res.json() as { success: boolean; error: { code: string; message: string } };
      assert.equal(body.success, false);
      assert.equal(body.error.code, 'INVALID_JSON');
      assert.equal(body.error.message, 'Invalid JSON');
      assert.ok(!JSON.stringify(body).includes(SECRET));
    });
  } finally {
    consoleCapture.restore();
  }
  assert.ok(!consoleCapture.text().includes(SECRET), consoleCapture.text());
  assert.ok(!consoleCapture.text().includes('x=1'), 'no query string in the log either');
});

test('AppError keeps its status and code; anything else is a logged 500', async () => {
  const consoleCapture = captureConsole();
  try {
    await withApp(async (base) => {
      const appError = await fetch(`${base}/api/app-error`);
      assert.equal(appError.status, 409);
      assert.deepEqual(await appError.json(), { success: false, error: { code: 'NOPE', message: 'Nope.' } });
      const crash = await fetch(`${base}/api/crash`);
      assert.equal(crash.status, 500);
      assert.equal(((await crash.json()) as { error: { code: string } }).error.code, 'INTERNAL_ERROR');
    });
  } finally {
    consoleCapture.restore();
  }
  assert.match(consoleCapture.text(), /boom/);
});

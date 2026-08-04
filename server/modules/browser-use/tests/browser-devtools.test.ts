import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachPageRecorder,
  CONSOLE_LIMIT,
  DevtoolsRecorder,
  NETWORK_LIMIT,
} from '@/modules/browser-use/browser-devtools.js';

function fakeClock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('console entries keep insertion order and are capped', () => {
  const recorder = new DevtoolsRecorder();

  for (let index = 0; index < CONSOLE_LIMIT + 25; index += 1) {
    recorder.addConsole({ type: 'log', text: `message ${index}` });
  }

  const entries = recorder.getConsole({ limit: CONSOLE_LIMIT });
  assert.equal(entries.length, CONSOLE_LIMIT);
  assert.equal(entries[0].text, 'message 25');
  assert.equal(entries.at(-1)?.text, `message ${CONSOLE_LIMIT + 24}`);
});

test('error level also returns uncaught page exceptions', () => {
  const recorder = new DevtoolsRecorder();
  recorder.addConsole({ type: 'log', text: 'hello' });
  recorder.addConsole({ type: 'error', text: 'console error' });
  recorder.addConsole({ type: 'pageerror', text: 'TypeError: x is not a function' });

  const errors = recorder.getConsole({ level: 'error' });

  assert.deepEqual(errors.map((entry) => entry.type), ['error', 'pageerror']);
});

test('console search filters on message text', () => {
  const recorder = new DevtoolsRecorder();
  recorder.addConsole({ type: 'log', text: 'viewport is 393px' });
  recorder.addConsole({ type: 'log', text: 'unrelated' });

  assert.deepEqual(recorder.getConsole({ search: 'VIEWPORT' }).map((entry) => entry.text), ['viewport is 393px']);
});

test('network entries record status, duration, and failures', () => {
  const clock = fakeClock();
  const recorder = new DevtoolsRecorder(clock.now);
  const ok = {};
  const missing = {};
  const broken = {};

  recorder.startRequest(ok, { method: 'get', url: 'https://ethia.cz/', resourceType: 'document' });
  recorder.startRequest(missing, { method: 'GET', url: 'https://ethia.cz/missing.css', resourceType: 'stylesheet' });
  recorder.startRequest(broken, { method: 'GET', url: 'https://offline.invalid/x.js', resourceType: 'script' });
  clock.advance(120);
  recorder.finishRequest(ok, { status: 200, statusText: 'OK' });
  recorder.finishRequest(missing, { status: 404, statusText: 'Not Found' });
  recorder.failRequest(broken, 'net::ERR_NAME_NOT_RESOLVED');

  const all = recorder.getNetwork();
  assert.equal(all.length, 3);
  assert.equal(all[0].method, 'GET');
  assert.equal(all[0].status, 200);
  assert.equal(all[0].ok, true);
  assert.equal(all[0].durationMs, 120);

  const failed = recorder.getNetwork({ onlyFailed: true });
  assert.deepEqual(failed.map((entry) => entry.url), [
    'https://ethia.cz/missing.css',
    'https://offline.invalid/x.js',
  ]);
  assert.equal(failed[1].failure, 'net::ERR_NAME_NOT_RESOLVED');
});

test('network filters by url substring and resource type', () => {
  const recorder = new DevtoolsRecorder();
  recorder.startRequest({}, { method: 'GET', url: 'https://ethia.cz/app.js', resourceType: 'script' });
  recorder.startRequest({}, { method: 'GET', url: 'https://cdn.example.com/app.css', resourceType: 'stylesheet' });

  assert.equal(recorder.getNetwork({ urlContains: 'ethia' }).length, 1);
  assert.equal(recorder.getNetwork({ resourceType: 'stylesheet' }).length, 1);
});

test('network buffer is capped', () => {
  const recorder = new DevtoolsRecorder();
  for (let index = 0; index < NETWORK_LIMIT + 10; index += 1) {
    recorder.startRequest({}, { method: 'GET', url: `https://ethia.cz/${index}`, resourceType: 'fetch' });
  }

  assert.equal(recorder.getNetwork({ limit: NETWORK_LIMIT }).length, NETWORK_LIMIT);
});

test('counts summarize what the agent should look at first', () => {
  const recorder = new DevtoolsRecorder();
  const failing = {};
  recorder.addConsole({ type: 'error', text: 'boom' });
  recorder.addConsole({ type: 'warning', text: 'careful' });
  recorder.addConsole({ type: 'log', text: 'fine' });
  recorder.startRequest(failing, { method: 'GET', url: 'https://ethia.cz/a', resourceType: 'fetch' });
  recorder.finishRequest(failing, { status: 500 });

  assert.deepEqual(recorder.counts(), {
    console: 3,
    errors: 1,
    warnings: 1,
    requests: 1,
    failedRequests: 1,
  });
});

test('clear empties both buffers', () => {
  const recorder = new DevtoolsRecorder();
  recorder.addConsole({ type: 'log', text: 'x' });
  recorder.startRequest({}, { method: 'GET', url: 'https://ethia.cz', resourceType: 'document' });

  recorder.clear();

  assert.deepEqual(recorder.getConsole(), []);
  assert.deepEqual(recorder.getNetwork(), []);
});

test('attachPageRecorder wires playwright page events into the buffers', () => {
  const listeners = new Map<string, Array<(payload: any) => void>>();
  const page = {
    on(event: string, handler: (payload: any) => void) {
      listeners.set(event, [...(listeners.get(event) || []), handler]);
    },
    off(event: string, handler: (payload: any) => void) {
      listeners.set(event, (listeners.get(event) || []).filter((item) => item !== handler));
    },
    once() {},
  };
  const emit = (event: string, payload: any) => {
    for (const handler of listeners.get(event) || []) {
      handler(payload);
    }
  };

  const recorder = new DevtoolsRecorder();
  const detach = attachPageRecorder(page, recorder);

  emit('console', {
    type: () => 'warning',
    text: () => 'layout shift',
    location: () => ({ url: 'https://ethia.cz/app.js', lineNumber: 12, columnNumber: 4 }),
  });
  emit('pageerror', new Error('boom'));

  const request = {
    method: () => 'GET',
    url: () => 'https://ethia.cz/api/data',
    resourceType: () => 'fetch',
    failure: () => ({ errorText: 'net::ERR_ABORTED' }),
  };
  emit('request', request);
  emit('response', { request: () => request, status: () => 503, statusText: () => 'Service Unavailable' });

  const [warning, pageError] = recorder.getConsole();
  assert.equal(warning.type, 'warning');
  assert.equal(warning.location, 'https://ethia.cz/app.js:12:4');
  assert.equal(pageError.type, 'pageerror');
  assert.match(pageError.text, /boom/);

  const [entry] = recorder.getNetwork();
  assert.equal(entry.status, 503);
  assert.equal(entry.ok, false);

  detach();
  emit('console', { type: () => 'log', text: () => 'after detach' });
  assert.equal(recorder.getConsole().length, 2);
});

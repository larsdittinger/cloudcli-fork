import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useStaleBuildCheck } from '@/modules/stale-build/hooks/useStaleBuildCheck';
import type { ServerEvent } from '@/shared/types';

/**
 * A deploy restarts the server; open tabs only reconnect their socket and keep
 * running the old bundle for hours. Fixes never reach them, and old code
 * talking to a new server is exactly how "I click Send and nothing happens"
 * survived its own fix on 2026-10-06. A tab must notice it is out of date.
 */

const indexHtml = (bundle: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="/assets/${bundle}"></script></head></html>`;

let served = 'index-OLD.js';
const fetchMock = vi.fn(async () => ({ ok: true, text: async () => indexHtml(served) }));
let listener: ((event: ServerEvent) => void) | null = null;
const subscribe = (fn: (event: ServerEvent) => void) => {
  listener = fn;
  return () => { listener = null; };
};

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
};

beforeEach(() => {
  served = 'index-OLD.js';
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  setVisibility('visible');
  const script = document.createElement('script');
  script.type = 'module';
  script.src = '/assets/index-OLD.js';
  script.dataset.testEntry = '1';
  document.head.appendChild(script);
});

afterEach(() => {
  document.querySelectorAll('script[data-test-entry]').forEach((node) => node.remove());
  vi.unstubAllGlobals();
});

const reconnect = async () => {
  await act(async () => {
    listener?.({ kind: 'websocket_reconnected' } as ServerEvent);
    await Promise.resolve();
    await Promise.resolve();
  });
};

test('the same bundle on the server is not stale', async () => {
  const view = renderHook(() => useStaleBuildCheck({ subscribe }));
  await reconnect();
  assert.equal(fetchMock.mock.calls.length, 1);
  assert.equal(view.result.current.isStale, false);
});

test('a new bundle after a reconnect marks the tab stale', async () => {
  const view = renderHook(() => useStaleBuildCheck({ subscribe }));
  served = 'index-NEW.js';
  await reconnect();
  assert.equal(view.result.current.isStale, true);
});

test('a reconnect right after another check is still checked', async () => {
  // Coming back to the tab checks; the deploy can land seconds later.
  const view = renderHook(() => useStaleBuildCheck({ subscribe }));
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(fetchMock.mock.calls.length, 1);

  served = 'index-NEW.js';
  await reconnect();
  assert.equal(fetchMock.mock.calls.length, 2);
  assert.equal(view.result.current.isStale, true);
});

test('a failed check is not a new version and does not use up the window', async () => {
  const view = renderHook(() => useStaleBuildCheck({ subscribe }));
  fetchMock.mockImplementationOnce(async () => { throw new Error('offline'); });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
  });
  assert.equal(view.result.current.isStale, false);

  served = 'index-NEW.js';
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(view.result.current.isStale, true);
});

test('without a built entry bundle (vite dev) nothing is checked', async () => {
  document.querySelectorAll('script[data-test-entry]').forEach((node) => node.remove());
  renderHook(() => useStaleBuildCheck({ subscribe }));
  await reconnect();
  assert.equal(fetchMock.mock.calls.length, 0);
});

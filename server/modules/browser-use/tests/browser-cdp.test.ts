import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readCdpConfig,
  probeCdp,
  supportsCdpTarget,
  DEFAULT_CDP_TIMEOUT_MS,
} from '@/modules/browser-use/browser-cdp.js';
import { defaultEmulation, findPreset, resolveEmulation } from '@/modules/browser-use/browser-emulation.js';

test('bez promenne je CDP vypnute', () => {
  assert.equal(readCdpConfig({}).url, null);
  assert.equal(readCdpConfig({ CLOUDCLI_BROWSER_CDP_URL: '   ' }).url, null);
});

test('URL se normalizuje — schema se doplni, koncove lomitko zmizi', () => {
  assert.equal(readCdpConfig({ CLOUDCLI_BROWSER_CDP_URL: '172.17.0.1:9222' }).url, 'http://172.17.0.1:9222');
  assert.equal(readCdpConfig({ CLOUDCLI_BROWSER_CDP_URL: 'http://mac:9222/' }).url, 'http://mac:9222');
});

test('nesmyslna URL CDP vypne, misto aby shodila launch', () => {
  assert.equal(readCdpConfig({ CLOUDCLI_BROWSER_CDP_URL: 'ws://nope:9222' }).url, null);
  assert.equal(readCdpConfig({ CLOUDCLI_BROWSER_CDP_URL: 'http://' }).url, null);
});

test('timeout ma default a drzi se v rozumnych mezich', () => {
  const base = { CLOUDCLI_BROWSER_CDP_URL: 'http://mac:9222' };
  assert.equal(readCdpConfig(base).timeoutMs, DEFAULT_CDP_TIMEOUT_MS);
  assert.equal(readCdpConfig({ ...base, CLOUDCLI_BROWSER_CDP_TIMEOUT_MS: '2500' }).timeoutMs, 2500);
  assert.equal(readCdpConfig({ ...base, CLOUDCLI_BROWSER_CDP_TIMEOUT_MS: '5' }).timeoutMs, 100);
  assert.equal(readCdpConfig({ ...base, CLOUDCLI_BROWSER_CDP_TIMEOUT_MS: 'nic' }).timeoutMs, DEFAULT_CDP_TIMEOUT_MS);
});

test('probe uspeje, kdyz endpoint vrati verzi prohlizece', async () => {
  const result = await probeCdp('http://mac:9222', {
    timeoutMs: 50,
    fetchImpl: async (url: string) => {
      assert.equal(url, 'http://mac:9222/json/version');
      return {
        ok: true,
        json: async () => ({ Browser: 'Chrome/152.0.7977.83', webSocketDebuggerUrl: 'ws://mac:9222/devtools/browser/x' }),
      } as any;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.browser, 'Chrome/152.0.7977.83');
});

test('probe selze pri nedostupnem endpointu — bez vyjimky', async () => {
  const result = await probeCdp('http://mac:9222', {
    timeoutMs: 50,
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /ECONNREFUSED/);
});

test('probe selze pri HTTP chybe i pri odpovedi bez debuggeru', async () => {
  const http500 = await probeCdp('http://mac:9222', {
    timeoutMs: 50,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) as any,
  });
  assert.equal(http500.ok, false);

  const cizi = await probeCdp('http://mac:9222', {
    timeoutMs: 50,
    fetchImpl: async () => ({ ok: true, json: async () => ({ hello: 'world' }) }) as any,
  });
  assert.equal(cizi.ok, false);
});

test('probe nevisi dele nez timeout', async () => {
  const started = Date.now();
  const result = await probeCdp('http://mac:9222', {
    timeoutMs: 60,
    fetchImpl: (_url: string, init: any) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  assert.equal(result.ok, false);
  assert.ok(Date.now() - started < 1000);
});

test('do nativniho Chromu jde jen desktop — emulovane zarizeni zustava na patchrightu', () => {
  assert.equal(supportsCdpTarget(defaultEmulation()), true);
  const iphone = resolveEmulation({ device: 'iphone-15' });
  assert.ok(findPreset('iphone-15'));
  assert.equal(supportsCdpTarget(iphone), false);
  assert.equal(supportsCdpTarget(resolveEmulation({ width: 800, height: 600 })), false);
});

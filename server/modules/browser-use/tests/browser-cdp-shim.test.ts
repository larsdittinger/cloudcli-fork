import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import { startCdpShim } from '@/modules/browser-use/browser-cdp-shim.js';

/**
 * Falesny Chrome: /json/version + browser websocket, ktery si pamatuje, co mu
 * doopravdy doslo. Odpovida na vse prazdnym resultem.
 */
async function fakeChrome(): Promise<{
  url: string;
  prijate: string[];
  close: () => Promise<void>;
}> {
  const prijate: string[] = [];
  const server = http.createServer((_request, response) => {
    const { port } = server.address() as AddressInfo;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      Browser: 'Chrome/152.0.0.0',
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`,
    }));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      prijate.push(message.method);
      socket.send(JSON.stringify({ id: message.id, result: { doslo: message.method } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    prijate,
    close: () => new Promise<void>((resolve) => {
      wss.close(() => server.close(() => resolve()));
    }),
  };
}

async function zavolej(shimUrl: string, prikazy: Array<{ id: number; method: string }>): Promise<any[]> {
  const version = await (await fetch(`${shimUrl}/json/version`)).json();
  const client = new WebSocket(version.webSocketDebuggerUrl);
  const odpovedi: any[] = [];
  await new Promise<void>((resolve) => client.on('open', () => resolve()));
  await new Promise<void>((resolve) => {
    client.on('message', (data) => {
      odpovedi.push(JSON.parse(data.toString()));
      if (odpovedi.length === prikazy.length) {
        resolve();
      }
    });
    for (const prikaz of prikazy) {
      client.send(JSON.stringify({ ...prikaz, params: {} }));
    }
  });
  client.close();
  return odpovedi;
}

test('shim spolkne setDownloadBehavior a odpovi za nej sam', async () => {
  const chrome = await fakeChrome();
  const shim = await startCdpShim({ targetUrl: chrome.url });
  try {
    const odpovedi = await zavolej(shim.url, [
      { id: 1, method: 'Browser.setDownloadBehavior' },
      { id: 2, method: 'Target.getBrowserContexts' },
    ]);

    // Chrome 152 by na prvnim prikazu spojeni shodil, takze k nemu vubec nesmi.
    assert.deepEqual(chrome.prijate, ['Target.getBrowserContexts']);
    assert.deepEqual(odpovedi.find((o) => o.id === 1), { id: 1, result: {} });
    assert.deepEqual(odpovedi.find((o) => o.id === 2)?.result, { doslo: 'Target.getBrowserContexts' });
  } finally {
    await shim.close();
    await chrome.close();
  }
});

test('shim v /json/version nabidne sebe, ne adresu Chromu', async () => {
  const chrome = await fakeChrome();
  const shim = await startCdpShim({ targetUrl: chrome.url });
  try {
    const version = await (await fetch(`${shim.url}/json/version`)).json();
    assert.equal(version.Browser, 'Chrome/152.0.0.0');
    assert.ok(
      version.webSocketDebuggerUrl.includes(new URL(shim.url).port),
      `${version.webSocketDebuggerUrl} ma mirit na shim`,
    );
  } finally {
    await shim.close();
    await chrome.close();
  }
});

test('nedostupny Chrome znamena chybu pri startu, ne visici shim', async () => {
  await assert.rejects(
    startCdpShim({ targetUrl: 'http://127.0.0.1:1', timeoutMs: 300 }),
  );
});

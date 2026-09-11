import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocket, WebSocketServer } from 'ws';

/**
 * ethia fork: tenky CDP preposilac mezi Playwrightem a pripojenym Chromem.
 *
 * Chrome 152 odmita `Browser.setDownloadBehavior` nad skutecnym uzivatelskym
 * profilem ("Browser context management is not supported") — spravovat se pres
 * CDP smi jen kontext, ktery si vytvoril sam DevTools klient. Playwright ten
 * prikaz posila hned po pripojeni, takze by connectOverCDP spadl driv, nez se
 * stihne cokoli otevrit. Overeno rucnim CDP volanim: Target.createBrowserContext
 * projde, tenhle jediny prikaz ne.
 *
 * Shim proto sedi mezi nimi, vsechno ostatni preposila beze zmeny a na tenhle
 * jeden prikaz odpovi sam. Nastaveni stahovani se tim zahodi — agent zadne
 * soubory do instance nestahuje, pracuje pres screenshoty a DOM.
 *
 * Az to Playwright (nebo Chrome) srovna, cely soubor zmizi a launch pujde na
 * CDP URL primo.
 */

const SWALLOWED_METHODS = new Set(['Browser.setDownloadBehavior']);

export type CdpShim = {
  /** URL pro connectOverCDP — ukazuje na shim, ne na Chrome. */
  url: string;
  close: () => Promise<void>;
};

type ShimOptions = {
  /** `http://host:port` pripojeneho Chromu. */
  targetUrl: string;
  timeoutMs?: number;
};

export async function startCdpShim({ targetUrl, timeoutMs = 10_000 }: ShimOptions): Promise<CdpShim> {
  const version = await fetchJson(`${targetUrl}/json/version`, timeoutMs);
  const upstreamWsUrl = String(version?.webSocketDebuggerUrl || '');
  if (!upstreamWsUrl) {
    throw new Error('CDP endpoint nevratil webSocketDebuggerUrl');
  }

  const sockets = new Set<WebSocket>();
  const server = http.createServer((request, response) => {
    // Playwright si sahne jen pro /json/version a ceka v ni adresu, na kterou
    // se ma pripojit — proto ji prepisujeme na sebe.
    void (async () => {
      try {
        const path = request.url || '/';
        const payload = await fetchJson(`${targetUrl}${path}`, timeoutMs);
        const body = path.startsWith('/json/version')
          ? { ...payload, webSocketDebuggerUrl: localWsUrl(server) }
          : payload;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
      } catch (error: any) {
        response.writeHead(502, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: error?.message || String(error) }));
      }
    })();
  });

  const wss = new WebSocketServer({ server, perMessageDeflate: false });
  wss.on('connection', (client) => {
    const upstream = new WebSocket(upstreamWsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    sockets.add(client);
    sockets.add(upstream);

    // Dokud upstream nenabehne, zpravy od klienta cekaji ve fronte — Playwright
    // posila prvni prikaz okamzite po otevreni spojeni.
    const fronta: string[] = [];
    const posli = (raw: string) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(raw);
      } else {
        fronta.push(raw);
      }
    };

    upstream.on('open', () => {
      for (const raw of fronta.splice(0)) {
        upstream.send(raw);
      }
    });
    upstream.on('message', (data) => client.readyState === WebSocket.OPEN && client.send(data.toString()));
    upstream.on('close', () => client.close());
    upstream.on('error', () => client.close());

    client.on('message', (data) => {
      const raw = data.toString();
      const zprava = parseMessage(raw);
      if (zprava && SWALLOWED_METHODS.has(zprava.method)) {
        client.send(JSON.stringify({ id: zprava.id, result: {} }));
        return;
      }
      posli(raw);
    });
    client.on('close', () => upstream.close());
    client.on('error', () => upstream.close());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) {
        socket.close();
      }
      sockets.clear();
      wss.close(() => server.close(() => resolve()));
    }),
  };
}

function localWsUrl(server: http.Server): string {
  const { port } = server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}/devtools/browser/shim`;
}

function parseMessage(raw: string): { id: number; method: string } | null {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.method === 'string' && typeof parsed?.id === 'number'
      ? { id: parsed.id, method: parsed.method }
      : null;
  } catch {
    return null;
  }
}

async function fetchJson(url: string, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${url} -> HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

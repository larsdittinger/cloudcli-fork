import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { connectSpawn, DaemonRejectedError } from '../daemon/client.js';
import { startDaemon, type RunningDaemon } from '../daemon/daemon.js';

const TOKEN = 'test-token';
let tmp: string;
let daemon: RunningDaemon;
let target: http.Server;
let targetPort: number;
let mainServer: http.Server;
const SECRET = 's3cret';

const auth = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

function daemonRequest(method: string, pathname: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: daemon.socketPath, method, path: pathname, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbxp-'));
  target = http.createServer((req, res) => res.writeHead(200, { 'x-target': 'yes' }).end(`hello ${req.url}`));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  targetPort = (target.address() as net.AddressInfo).port;

  mainServer = http.createServer((req, res) => {
    res.writeHead(201, { 'x-main': 'ok', 'content-type': 'text/event-stream' });
    res.write(`1:${req.headers.authorization}:${req.method}:${req.url}\n`);
    setTimeout(() => res.end('2\n'), 150);
  });
  await new Promise<void>((r) => mainServer.listen(path.join(tmp, 'main.sock'), r));

  daemon = await startDaemon({ token: TOKEN, isolationDir: tmp, dev: true, proxyPort: 0, forwardPort: 0, proxyHttpPorts: [targetPort] });
  const put = await daemonRequest('PUT', '/v1/projects/p1', { uid: 20001, name: 'Mail', allowlist: ['localhost'], proxySecret: SECRET });
  assert.equal(put.status, 200);
});

after(async () => {
  await daemon.close();
  target.close();
  mainServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function connectVia(host: string, port: number, authHeader?: string): Promise<{ status: number; body: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(daemon.proxyPort, '127.0.0.1');
    let data = '';
    socket.on('connect', () =>
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${authHeader ? `Proxy-Authorization: ${authHeader}\r\n` : ''}\r\n`),
    );
    socket.on('data', (chunk) => {
      data += chunk.toString();
      const end = data.indexOf('\r\n\r\n');
      if (end >= 0) {
        const status = Number(data.slice(9, 12));
        const rest = data.slice(end + 4);
        const lengthMatch = /content-length: (\d+)/i.exec(data);
        if (status === 200 || !lengthMatch || rest.length >= Number(lengthMatch[1])) resolve({ status, body: rest, socket });
      }
    });
    socket.on('error', reject);
  });
}

test('allowed CONNECT passes through', async () => {
  const res = await connectVia('localhost', targetPort, auth('p1', SECRET));
  assert.equal(res.status, 200);
  const reply = new Promise<string>((resolve) => res.socket.once('data', (d) => resolve(d.toString())));
  res.socket.write(`GET /via-connect HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
  assert.match(await reply, /hello \/via-connect/);
  res.socket.destroy();
});

test('forbidden CONNECT is 403 with text and shows in blocked log', async () => {
  const res = await connectVia('evil.example', 443, auth('p1', SECRET));
  assert.equal(res.status, 403);
  assert.equal(res.body, 'CloudCLI sandbox: evil.example is not in the allowlist of isolated project Mail. Add it in Isolation settings.');
  res.socket.destroy();
  const blocked = await daemonRequest('GET', '/v1/blocked?projectId=p1');
  assert.equal(blocked.status, 200);
  assert.equal(blocked.json.at(-1).host, 'evil.example');
  assert.equal(blocked.json.at(-1).port, 443);
  assert.equal(blocked.json.at(-1).kind, 'connect');
  assert.ok(blocked.json.at(-1).at);
});

test('wrong or missing proxy credentials are 407', async () => {
  for (const header of [auth('p1', 'nope'), auth('unknown', SECRET), undefined]) {
    const res = await connectVia('localhost', targetPort, header);
    assert.equal(res.status, 407);
    res.socket.destroy();
  }
});

test('absolute-form HTTP GET passes, forbidden host is 403', async () => {
  const ok = await new Promise<{ status: number; body: string; header: string }>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: daemon.proxyPort, path: `http://localhost:${targetPort}/abs?x=1`, headers: { 'Proxy-Authorization': auth('p1', SECRET), Host: `localhost:${targetPort}` } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, header: String(res.headers['x-target']) }));
      })
      .on('error', reject);
  });
  assert.deepEqual(ok, { status: 200, body: 'hello /abs?x=1', header: 'yes' });

  const denied = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: daemon.proxyPort, path: 'http://evil.example/', headers: { 'Proxy-Authorization': auth('p1', SECRET) } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
  assert.equal(denied.status, 403);
  assert.match(denied.body, /evil\.example is not in the allowlist of isolated project Mail/);
});

test('forward 7701 passes status, headers and streamed chunks to main.sock', async () => {
  const chunks: Array<{ at: number; text: string }> = [];
  const start = Date.now();
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: daemon.forwardPort, method: 'POST', path: '/api/x?y=1', headers: { Authorization: 'Bearer run-token' } }, resolve);
    req.on('error', reject);
    req.end('body');
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.headers['x-main'], 'ok');
  await new Promise<void>((resolve) => {
    res.on('data', (c: Buffer) => chunks.push({ at: Date.now() - start, text: c.toString() }));
    res.on('end', resolve);
  });
  assert.equal(chunks[0].text, '1:Bearer run-token:POST:/api/x?y=1\n');
  assert.equal(chunks.map((c) => c.text).join(''), '1:Bearer run-token:POST:/api/x?y=1\n2\n');
  assert.ok(chunks.length >= 2 && chunks.at(-1)!.at - chunks[0].at >= 100, 'chunks arrive separately');
});

test('forward without main.sock listener is 502', async () => {
  const lonely = fs.mkdtempSync(path.join(os.tmpdir(), 'sbxq-'));
  const d = await startDaemon({ token: TOKEN, isolationDir: lonely, dev: true, proxyPort: 0, forwardPort: 0 });
  const status = await new Promise<number>((resolve, reject) =>
    http.get({ host: '127.0.0.1', port: d.forwardPort, path: '/' }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject),
  );
  assert.equal(status, 502);
  await d.close();
  fs.rmSync(lonely, { recursive: true, force: true });
});

test('project config persists 0600 and reloads; invalid config is rejected', async () => {
  const file = path.join(tmp, 'state', 'projects.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const bad = await daemonRequest('PUT', '/v1/projects/p2', { uid: 5, name: 'x', allowlist: [], proxySecret: 'a' });
  assert.equal(bad.status, 400);
  const badList = await daemonRequest('PUT', '/v1/projects/p2', { uid: 20002, name: 'x', allowlist: ['1.2.3.4'], proxySecret: 'a' });
  assert.equal(badList.status, 400);

  const second = await startDaemon({ token: TOKEN, isolationDir: tmp, dev: true, proxyPort: 0, forwardPort: 0, proxyHttpPorts: [targetPort], socketPath: path.join(tmp, 'd2.sock') });
  const status = await new Promise<number>((resolve, reject) => {
    const sock = net.connect(second.proxyPort, '127.0.0.1', () =>
      sock.write(`CONNECT localhost:${targetPort} HTTP/1.1\r\nProxy-Authorization: ${auth('p1', SECRET)}\r\n\r\n`),
    );
    sock.once('data', (d) => { resolve(Number(d.toString().slice(9, 12))); sock.destroy(); });
    sock.on('error', reject);
  });
  assert.equal(status, 200);
  await second.close();
});

test('fails closed: firewall failure refuses spawn and status reports it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbxf-'));
  const d = await startDaemon({
    token: TOKEN, isolationDir: dir, dev: true, proxyPort: 0, forwardPort: 0,
    applyNetwork: async () => { throw new Error('iptables missing'); },
  });
  const status = await new Promise<{ status: number; body: any }>((resolve, reject) => {
    http.get({ socketPath: d.socketPath, path: '/v1/status', headers: { Authorization: `Bearer ${TOKEN}` } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(b) }));
    }).on('error', reject);
  });
  assert.equal(status.status, 503);
  assert.equal(status.body.ok, false);
  assert.match(status.body.reason, /iptables missing/);
  await assert.rejects(
    connectSpawn(d.socketPath, TOKEN, { kind: 'exec', uid: 20001, projectDir: dir, homeDir: dir, args: ['true'], env: {}, cwd: dir }),
    DaemonRejectedError,
  );
  await d.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

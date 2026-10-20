// HTTP(S) egress proxy for isolated projects: CONNECT and absolute-form HTTP, per-project Basic auth.
// Node builtins only.
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

import { DEFAULT_HTTP_PORTS, isHttpAllowed, normalizeHost, type AllowEntry } from './allowlist.js';

export type ProxyProject = { name: string; entries: AllowEntry[]; proxySecret: string };

export type BlockedEntry = { at: string; host: string; port: number; kind: 'connect' | 'http' };

export class BlockedLog {
  private readonly byProject = new Map<string, BlockedEntry[]>();
  constructor(private readonly limit = 200) {}

  add(projectId: string, entry: BlockedEntry): void {
    const list = this.byProject.get(projectId) ?? [];
    list.push(entry);
    if (list.length > this.limit) list.splice(0, list.length - this.limit);
    this.byProject.set(projectId, list);
  }

  list(projectId: string): BlockedEntry[] {
    return [...(this.byProject.get(projectId) ?? [])];
  }
}

export type EgressProxyOptions = {
  getProject: (projectId: string) => ProxyProject | undefined;
  blocked: BlockedLog;
  /** Ports a plain `domain` entry covers. Tests widen this to reach a local target. */
  httpPorts?: readonly number[];
};

const HOP_BY_HOP = ['connection', 'proxy-connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authenticate(header: string | undefined, getProject: EgressProxyOptions['getProject']) {
  const match = /^Basic\s+(\S+)$/i.exec(header ?? '');
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  const projectId = decoded.slice(0, colon);
  const project = getProject(projectId);
  if (!project || !safeEqual(decoded.slice(colon + 1), project.proxySecret)) return null;
  return { projectId, project };
}

function splitHostPort(target: string, defaultPort: number): { host: string; port: number } | null {
  const match = /^(?:\[([^\]]+)\]|([^:]+))(?::(\d+))?$/.exec(target);
  if (!match) return null;
  const port = match[3] ? Number(match[3]) : defaultPort;
  const host = match[1] ?? match[2];
  return port >= 1 && port <= 65535 ? { host, port } : null;
}

const denialText = (host: string, projectName: string) =>
  `CloudCLI sandbox: ${host} is not in the allowlist of isolated project ${projectName}. Add it in Isolation settings.`;

export function createEgressProxy(options: EgressProxyOptions): http.Server {
  const httpPorts = options.httpPorts ?? DEFAULT_HTTP_PORTS;
  const server = http.createServer();

  server.on('connect', (req, clientSocket: net.Socket, head) => {
    clientSocket.on('error', () => clientSocket.destroy());
    const auth = authenticate(req.headers['proxy-authorization'], options.getProject);
    if (!auth) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="cloudcli-sandbox"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const target = splitHostPort(req.url ?? '', 443);
    if (!target) return void clientSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    const host = normalizeHost(target.host) || target.host;
    if (!isHttpAllowed(auth.project.entries, target.host, target.port, httpPorts)) {
      options.blocked.add(auth.projectId, { at: new Date().toISOString(), host, port: target.port, kind: 'connect' });
      const body = denialText(host, auth.project.name);
      return void clientSocket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }
    const upstream = net.connect(target.port, host);
    upstream.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    let connected = false;
    upstream.once('connect', () => (connected = true));
    upstream.on('error', () => {
      if (!connected) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      else clientSocket.destroy();
    });
    upstream.on('close', () => clientSocket.destroy());
    clientSocket.on('close', () => upstream.destroy());
  });

  server.on('request', (req, res) => {
    const auth = authenticate(req.headers['proxy-authorization'], options.getProject);
    if (!auth) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="cloudcli-sandbox"', 'Content-Length': 0 }).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { 'Content-Length': 0 }).end();
      return;
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400, { 'Content-Length': 0 }).end();
      return;
    }
    const port = Number(url.port || 80);
    const host = normalizeHost(url.hostname) || url.hostname;
    if (!isHttpAllowed(auth.project.entries, url.hostname, port, httpPorts)) {
      options.blocked.add(auth.projectId, { at: new Date().toISOString(), host, port, kind: 'http' });
      const body = denialText(host, auth.project.name);
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }).end(body);
      return;
    }
    const headers = { ...req.headers };
    for (const name of HOP_BY_HOP) delete headers[name];
    headers.host = url.host; // the client's Host is untrusted; the request goes where the URL says
    const upstream = http.request({ host, port, method: req.method, path: `${url.pathname}${url.search}`, headers }, (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers };
      for (const name of HOP_BY_HOP) delete responseHeaders[name];
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Length': 0 }).end();
      else res.destroy();
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });

  return server;
}

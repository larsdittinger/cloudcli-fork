// Isolation self-check: a fixed probe script runs as the project's uid through the normal spawn path.
// Node builtins only. The script is embedded (not a separate file) so the tsc build ships it as is.
import { Duplex } from 'node:stream';
import path from 'node:path';

import { parseAllowlist } from './allowlist.js';
import { FrameDecoder, encodeFrame } from './frames.js';
import { hostProcess, type ProcessHostOptions, type SpawnRequest } from './process-host.js';

export type SelfCheckResult = { checks: Array<{ id: string; ok: boolean; detail: string }> };

export type SelfCheckContext = {
  projectId: string;
  request: SpawnRequest;
  runToken: string;
  /** Probe parameters (no secrets: the proxy credentials and the run token travel in the env). */
  config: ProbeConfig;
};

export type ProbeConfig = {
  uid: number;
  projectDir: string;
  isolatedRoot: string;
  socketPaths: string[];
  mainHomePaths: string[];
  workspace: string;
  forwardPort: number;
  allowHosts: string[];
  blockHost: string;
  probeTimeoutMs: number;
};

/** Ids that are always reported (`proxy-allows:<host>` comes on top, one per allowlisted domain). */
export const SELF_CHECK_IDS_STATIC = [
  'no-main-home',
  'no-workspace',
  'no-other-projects',
  'no-sockets',
  'no-direct-net',
  'no-dns',
  'proxy-blocks',
  'claude-api',
  'env-clean',
  'no-privileges',
] as const;

export const SELF_CHECK_TOTAL_TIMEOUT_MS = 30_000;
export const PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_BLOCK_HOST = 'example.com';
const ALT_BLOCK_HOST = 'blocked.cloudcli-sandbox-check.invalid';

export function buildProbeConfig(input: {
  request: SpawnRequest;
  allowlist: string[];
  isolatedRoot: string;
  isolationDir: string;
  forwardPort: number;
  mainHomePaths: string[];
}): ProbeConfig {
  const { entries } = parseAllowlist(input.allowlist);
  const domains = entries.filter((e) => e.kind === 'domain' && !e.wildcard).map((e) => e.host);
  const wildcards = entries.filter((e) => e.kind === 'domain' && e.wildcard).map((e) => e.host);
  const covers = (host: string) => domains.includes(host) || wildcards.some((w) => host.endsWith(`.${w}`));
  return {
    uid: input.request.uid,
    projectDir: input.request.projectDir,
    isolatedRoot: input.isolatedRoot,
    socketPaths: [path.join(input.isolationDir, 'daemon.sock'), path.join(input.isolationDir, 'main.sock')],
    mainHomePaths: input.mainHomePaths,
    workspace: '/workspace',
    forwardPort: input.forwardPort,
    allowHosts: domains,
    blockHost: covers(DEFAULT_BLOCK_HOST) ? ALT_BLOCK_HOST : DEFAULT_BLOCK_HOST,
    probeTimeoutMs: PROBE_TIMEOUT_MS,
  };
}

/** Plain CommonJS run by `node -` as the project uid. Prints one JSON line: { checks }. */
const PROBE_SCRIPT = String.raw`
'use strict';
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const http = require('http');
const dns = require('dns');
const { execFileSync } = require('child_process');
const T = CFG.probeTimeoutMs;
const checks = [];
const add = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail: String(detail) });
const guard = (id, fn) => Promise.resolve().then(fn).catch((e) => add(id, false, 'probe failed: ' + (e && e.message || e)));
const withTimeout = (p, ms, onTimeout) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(onTimeout), ms);
  p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); resolve({ error: e }); });
});

function canRead(p) {
  const out = [];
  try { fs.closeSync(fs.openSync(p, 'r')); out.push('open'); } catch (e) {}
  try { fs.readdirSync(p); out.push('list'); } catch (e) {}
  return out;
}

function tcp(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (r) => { s.destroy(); resolve(r); };
    s.setTimeout(T, () => done('timeout'));
    s.once('connect', () => done('connected'));
    s.once('error', (e) => done('error:' + (e.code || e.message)));
  });
}

function unixConnect(p) {
  return new Promise((resolve) => {
    const s = net.connect({ path: p });
    const done = (r) => { s.destroy(); resolve(r); };
    s.setTimeout(T, () => done('timeout'));
    s.once('connect', () => done('connected'));
    s.once('error', (e) => done('error:' + (e.code || e.message)));
  });
}

const proxy = (() => { try { return new URL(process.env.HTTPS_PROXY || ''); } catch (e) { return null; } })();

// CONNECT through the proxy; resolves { status, socket }.
function connectVia(host, port) {
  return new Promise((resolve, reject) => {
    if (!proxy) return reject(new Error('HTTPS_PROXY missing'));
    const auth = Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64');
    const req = http.request({ host: proxy.hostname, port: Number(proxy.port), method: 'CONNECT', path: host + ':' + port, headers: { 'Proxy-Authorization': 'Basic ' + auth, Host: host + ':' + port }, timeout: T });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode, socket }));
    req.on('timeout', () => { req.destroy(new Error('proxy timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function headOverTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host });
    const timer = setTimeout(() => { secure.destroy(); reject(new Error('tls timeout')); }, T);
    let data = '';
    secure.on('secureConnect', () => secure.write('HEAD / HTTP/1.1\r\nHost: ' + host + '\r\nConnection: close\r\n\r\n'));
    secure.on('data', (c) => { data += c.toString('latin1'); if (data.includes('\r\n')) { clearTimeout(timer); secure.destroy(); resolve(data.split('\r\n')[0]); } });
    secure.on('error', (e) => { clearTimeout(timer); reject(e); });
    secure.on('close', () => { clearTimeout(timer); if (!data) reject(new Error('closed without response')); });
  });
}

async function main() {
  await Promise.all([
    guard('no-main-home', () => {
      const readable = CFG.mainHomePaths.filter((p) => canRead(p).length);
      add('no-main-home', readable.length === 0, readable.length ? 'readable: ' + readable.join(', ') : 'not readable: ' + CFG.mainHomePaths.join(', '));
    }),
    guard('no-workspace', () => {
      const r = canRead(CFG.workspace);
      add('no-workspace', r.length === 0, r.length ? CFG.workspace + ' is accessible (' + r.join('+') + ')' : CFG.workspace + ' is not accessible');
    }),
    guard('no-other-projects', () => {
      const own = require('path').basename(CFG.projectDir);
      let names = [];
      try { names = fs.readdirSync(CFG.isolatedRoot); } catch (e) { add('no-other-projects', true, 'root is not listable'); return; }
      const open = names.filter((n) => n !== own && canRead(CFG.isolatedRoot + '/' + n).length);
      add('no-other-projects', open.length === 0, open.length ? 'accessible: ' + open.join(', ') : 'no other project accessible (' + names.length + ' entries listed)');
    }),
    guard('no-sockets', async () => {
      const results = await Promise.all(CFG.socketPaths.map(async (p) => p + ': ' + (await unixConnect(p))));
      add('no-sockets', results.every((r) => !r.endsWith(': connected') && !r.endsWith(': timeout')), results.join('; '));
    }),
    guard('no-direct-net', async () => {
      const r = await tcp('1.1.1.1', 443);
      add('no-direct-net', r !== 'connected', '1.1.1.1:443 -> ' + r);
    }),
    guard('no-dns', async () => {
      const r = await withTimeout(new Promise((resolve) => dns.lookup('example.com', (err, addr) => resolve(err ? { error: err } : { addr }))), T, 'timeout');
      const failed = r === 'timeout' || (r && r.error);
      add('no-dns', failed, failed ? 'lookup failed: ' + (r === 'timeout' ? 'timeout' : r.error.code || r.error.message) : 'resolved to ' + r.addr);
    }),
    guard('proxy-blocks', async () => {
      const r = await connectVia(CFG.blockHost, 443);
      r.socket.destroy();
      add('proxy-blocks', r.status === 403, CFG.blockHost + ' via proxy -> ' + r.status);
    }),
    ...CFG.allowHosts.map((host) => guard('proxy-allows:' + host, async () => {
      const r = await connectVia(host, 443);
      if (r.status !== 200) { r.socket.destroy(); add('proxy-allows:' + host, false, 'CONNECT -> ' + r.status); return; }
      const line = await headOverTls(r.socket, host);
      add('proxy-allows:' + host, /^HTTP\/\d/.test(line), line);
    }).catch(() => undefined)),
    guard('claude-api', () => new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: CFG.forwardPort, path: '/anthropic/v1/models', headers: { Authorization: 'Bearer ' + (process.env.CLOUDCLI_RUN_TOKEN || '') }, timeout: T }, (res) => {
        res.resume();
        add('claude-api', res.statusCode < 500, 'GET /anthropic/v1/models -> ' + res.statusCode);
        resolve();
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => { add('claude-api', false, 'forward unreachable: ' + (e.code || e.message)); resolve(); });
    })),
    guard('env-clean', () => {
      const allowed = new Set(['CLOUDCLI_RUN_TOKEN', 'HTTPS_PROXY']);
      const bad = Object.keys(process.env).filter((k) => /TOKEN|SECRET|PASSWORD|KEY/i.test(k) && !allowed.has(k));
      add('env-clean', bad.length === 0, bad.length ? 'unexpected: ' + bad.join(', ') : 'only the run token and proxy are set');
    }),
    guard('no-privileges', () => {
      const uid = Number(execFileSync('id', ['-u'], { encoding: 'utf8', timeout: T }).trim());
      let caps = 'unreadable';
      try { caps = (fs.readFileSync('/proc/self/status', 'utf8').match(/^CapEff:\s*([0-9a-f]+)/m) || [])[1] || 'unreadable'; } catch (e) {}
      const capsZero = /^0+$/.test(caps);
      add('no-privileges', uid === CFG.uid && capsZero, 'uid ' + uid + ' (want ' + CFG.uid + '), CapEff ' + caps);
    }),
  ]);
  process.stdout.write(JSON.stringify({ checks }) + '\n');
  process.exit(0);
}
main();
`;

export function probeScript(config: ProbeConfig): string {
  return `const CFG = ${JSON.stringify(config)};\n${PROBE_SCRIPT}`;
}

/** Duplex standing in for the upgraded socket so the check goes through hostProcess like any other spawn. */
export async function runProbeScript(
  ctx: SelfCheckContext,
  hostOptions: ProcessHostOptions,
  totalTimeoutMs = SELF_CHECK_TOTAL_TIMEOUT_MS,
): Promise<SelfCheckResult> {
  const decoder = new FrameDecoder();
  let stdout = '';
  let stderr = '';
  let errorText = '';
  let exited = false;
  let settle: () => void = () => undefined;
  const done = new Promise<void>((resolve) => (settle = resolve));
  const pipe = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, cb) {
      for (const frame of decoder.push(chunk)) {
        if (frame.type === 'stdout') stdout += frame.payload.toString('utf8');
        else if (frame.type === 'stderr') stderr += frame.payload.toString('utf8');
        else if (frame.type === 'error') errorText += frame.payload.toString('utf8');
        else if (frame.type === 'exit') exited = true;
      }
      cb();
    },
    final(cb) {
      settle();
      cb();
    },
  });
  const script = probeScript(ctx.config);
  const timer = setTimeout(() => {
    pipe.push(encodeFrame('kill', 'SIGKILL'));
    setTimeout(settle, 500).unref();
  }, totalTimeoutMs);
  hostProcess(pipe, ctx.request, hostOptions);
  pipe.push(encodeFrame('stdin', script));
  pipe.push(encodeFrame('stdin_end', ''));
  await done;
  clearTimeout(timer);
  pipe.push(null);
  pipe.destroy();
  if (errorText) throw new Error(errorText);
  const line = stdout.trim().split('\n').pop() ?? '';
  try {
    const parsed = JSON.parse(line) as SelfCheckResult;
    if (!Array.isArray(parsed.checks)) throw new Error('no checks');
    return parsed;
  } catch {
    throw new Error(`Self-check produced no result${exited ? '' : ' (timed out)'}: ${stderr.trim().slice(0, 500)}`);
  }
}

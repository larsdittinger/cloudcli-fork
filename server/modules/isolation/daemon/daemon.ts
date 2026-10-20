// Sandbox daemon: HTTP on a unix socket, upgraded to a framed duplex stream per process.
// Node builtins only: runs standalone in the sandbox image.
import { type ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { encodeFrame } from './frames.js';
import { createEgressProxy, BlockedLog } from './egress-proxy.js';
import {
  applyFirewallRules,
  applyHostsFile,
  buildFirewallRules,
  MIN_ISOLATED_UID,
  resolveHost,
  type FirewallProject,
} from './firewall.js';
import { createMainForward } from './main-forward.js';
import {
  adoptPaths,
  defaultStatOwner,
  expectedHome,
  HOME_TMP_DIR,
  prepareProject,
  validateSpawn,
  type PathConfig,
} from './projects.js';
import { buildProbeConfig, runProbeScript, type SelfCheckContext, type SelfCheckResult } from './self-check.js';
import { PROJECT_ID, ProjectStore, validateProjectConfig } from './project-store.js';
import { hostProcess, killGroup, parseSpawnRequest, type ProcessHostOptions } from './process-host.js';

export type DaemonOptions = {
  token: string;
  isolationDir: string;
  mainGid?: number;
  /** Tests only: replaces `process.setgroups([])` at production startup. */
  clearGroups?: () => void;
  isolatedRoot?: string;
  isolatedHomes?: string;
  dev?: boolean;
  claudeBin?: string;
  /** Override socket path (tests); defaults to <isolationDir>/daemon.sock. */
  socketPath?: string;
  /** Loopback ports; 0 picks an ephemeral port. Default: 7701 / 7702, or ephemeral in dev (tests). */
  forwardPort?: number;
  proxyPort?: number;
  /** Unix socket of the main app the forward passes through to; defaults to <isolationDir>/main.sock. */
  mainSocketPath?: string;
  /** Ports a plain `domain` entry covers; tests widen this to reach a local target. */
  proxyHttpPorts?: readonly number[];
  /** Applies firewall rules + hosts entries. Defaults to the real iptables in production, a no-op in dev. */
  applyNetwork?: (net: NetworkState) => Promise<void>;
  /** Re-resolve interval for TCP allowlist names (production). */
  resolveIntervalMs?: number;
  /** Resolves a TCP allowlist name to IPs; defaults to direct DNS (not /etc/hosts). */
  resolver?: (host: string) => Promise<string[]>;
  /** Owner uid of a path for the spawn check; tests simulate foreign owners. Defaults to a real stat. */
  statOwner?: (p: string) => number;
  /** Runs the isolation self-check; tests mock the probes. Defaults to the built-in script run as the project uid. */
  selfCheckRunner?: (ctx: SelfCheckContext) => Promise<SelfCheckResult>;
  /** Extra paths the project must not read (the main app's home), besides the built-in /home/cloudcli/.cloudcli/auth.db. */
  mainHome?: string;
  /** Daemon build/commit string for /v1/status. */
  version?: string;
};

export type NetworkState = {
  rules4: string[];
  rules6: string[];
  hosts: Array<{ ip: string; host: string }>;
};

export type RunningDaemon = {
  socketPath: string;
  forwardPort: number;
  proxyPort: number;
  close: () => Promise<void>;
};

const DEFAULT_FORWARD_PORT = 7701;
const DEFAULT_PROXY_PORT = 7702;
// The whole spawn request travels base64 in the X-Spawn header; real Claude args (MCP config JSON, system
// prompt flags) are far beyond Node's 16 KiB default.
const MAX_HEADER_BYTES = 1 << 20;

async function applyRealNetwork(state: NetworkState): Promise<void> {
  await applyFirewallRules(state.rules4, state.rules6);
  applyHostsFile(state.hosts);
}

function readBody(req: http.IncomingMessage, limit = 1 << 20): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** `claude --version`, cached for the daemon's life once it worked (failures are retried after a minute). */
function cachedClaudeVersion(claudeBin: string): () => Promise<string> {
  let value: string | undefined;
  let failedAt = 0;
  return () =>
    new Promise((resolve) => {
      if (value) return resolve(value);
      if (failedAt && Date.now() - failedAt < 60_000) return resolve('unknown');
      execFile(claudeBin, ['--version'], { timeout: 5000, env: { PATH: process.env.PATH ?? '' } }, (error, stdout) => {
        if (error || !stdout.trim()) {
          failedAt = Date.now();
          return resolve('unknown');
        }
        value = stdout.trim();
        resolve(value);
      });
    });
}

export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  if (!options.token) throw new Error('SANDBOX_DAEMON_TOKEN is required');
  const dev = Boolean(options.dev);
  if (!dev && (options.mainGid === undefined || !Number.isInteger(options.mainGid))) {
    throw new Error('CLOUDCLI_MAIN_GID is required outside SANDBOX_DEV (socket group would be root)');
  }
  if (!dev) {
    // node-pty's child switches uid/gid but not the supplementary groups; with none set on the daemon, every
    // child (pty or libuv) starts without the daemon's root groups. Refuse to start if that cannot be done.
    try {
      (options.clearGroups ?? (() => process.setgroups?.([])))();
    } catch (error) {
      throw new Error(`Cannot clear supplementary groups: ${(error as Error).message}`);
    }
  }
  const socketPath = options.socketPath ?? path.join(options.isolationDir, 'daemon.sock');
  const live = new Set<ChildProcess>();
  const hostOptions: ProcessHostOptions = {
    dev,
    live,
    claudeBin: options.claudeBin ?? process.env.CLAUDE_BIN ?? 'claude',
    gidFor: (uid) => uid,
  };

  process.umask(0o007);
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  fs.rmSync(socketPath, { force: true });

  const forwardPort = options.forwardPort ?? (dev ? 0 : DEFAULT_FORWARD_PORT);
  const proxyPort = options.proxyPort ?? (dev ? 0 : DEFAULT_PROXY_PORT);
  const pathConfig: PathConfig = {
    isolatedRoot: options.isolatedRoot ?? '/isolated',
    isolatedHomes: options.isolatedHomes ?? '/isolated-homes',
    statOwner: options.statOwner ?? defaultStatOwner,
  };
  const store = new ProjectStore(options.isolationDir);
  const claudeVersion = cachedClaudeVersion(hostOptions.claudeBin);
  const blocked = new BlockedLog(200);
  const applyNetwork = options.applyNetwork ?? (dev ? async () => undefined : applyRealNetwork);
  // Fail closed until the first successful apply: no spawn before the firewall exists.
  let netState: { ok: boolean; reason?: string } = { ok: false, reason: 'initializing' };
  const resolveName = options.resolver ?? resolveHost;
  let resolved = new Map<string, string[]>();
  let refreshChain: Promise<void> = Promise.resolve();

  // Resolves TCP allowlist names, rebuilds rules and applies them. Serialized; any failure marks the daemon not ok (spawn refused).
  const refreshNetwork = (): Promise<void> => {
    refreshChain = refreshChain.then(async () => {
      try {
        const next = new Map<string, string[]>();
        const projects: FirewallProject[] = [];
        const hosts: Array<{ ip: string; host: string }> = [];
        for (const project of store.all()) {
          const tcp: FirewallProject['tcp'] = [];
          for (const entry of project.entries) {
            if (entry.kind !== 'tcp') continue;
            let ips = next.get(entry.host);
            if (!ips) {
              try {
                ips = await resolveName(entry.host);
              } catch {
                ips = resolved.get(entry.host) ?? []; // keep the last known addresses on a DNS blip
              }
              next.set(entry.host, ips);
            }
            for (const ip of ips) tcp.push({ ip, port: entry.port });
          }
          projects.push({ uid: project.uid, tcp });
        }
        for (const [host, ips] of next) {
          if (net.isIP(host)) continue;
          for (const ip of ips) hosts.push({ ip, host });
        }
        resolved = next;
        const common = { proxyPort, forwardPort };
        await applyNetwork({
          rules4: buildFirewallRules(projects, { ...common, family: 4 }),
          rules6: buildFirewallRules(projects, { ...common, family: 6 }),
          hosts,
        });
        netState = { ok: true };
      } catch (error) {
        netState = { ok: false, reason: `Firewall could not be applied: ${(error as Error).message}` };
      }
    });
    return refreshChain;
  };

  let boundForwardPort = 0;
  let boundProxyPort = 0;
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
    const json = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }).end(text);
    };
    if (!tokenMatches(req.headers.authorization, options.token)) return json(401, { error: 'Unauthorized' });
    const url = new URL(req.url ?? '/', 'http://daemon');
    const projectMatch = /^\/v1\/projects\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && url.pathname === '/v1/status') {
      void claudeVersion().then((claude) =>
        json(netState.ok ? 200 : 503, {
          ...netState,
          version: options.version ?? 'dev',
          claudeVersion: claude,
          projects: store.all().length,
        }),
      );
      return;
    }
    const actionMatch = /^\/v1\/projects\/([^/]+)\/(prepare|self-check|adopt)$/.exec(url.pathname);
    if (req.method === 'POST' && actionMatch) {
      const projectId = decodeURIComponent(actionMatch[1]);
      if (!PROJECT_ID.test(projectId)) return json(400, { error: 'Invalid projectId' });
      void (async () => {
        try {
          const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
          if (actionMatch[2] === 'adopt') {
            const uid = body.uid;
            if (typeof uid !== 'number' || typeof body.projectDir !== 'string' || !Array.isArray(body.paths)) {
              return json(400, { error: 'uid, projectDir and paths are required' });
            }
            if (!Number.isInteger(uid) || uid < MIN_ISOLATED_UID) return json(400, { error: `uid must be an integer >= ${MIN_ISOLATED_UID}` });
            const known = store.get(projectId);
            if (!known) return json(409, { error: 'Unknown project: push its config (PUT) first' });
            if (known.uid !== uid) return json(409, { error: 'uid does not match the project' });
            const { warnings } = adoptPaths({ projectId, uid, projectDir: body.projectDir, paths: body.paths as string[] }, { ...pathConfig, dev, mainGid: options.mainGid });
            return json(200, { ok: true, warnings });
          }
          if (actionMatch[2] === 'prepare') {
            const uid = body.uid;
            if (typeof uid !== 'number' || typeof body.projectDir !== 'string' || typeof body.homeDir !== 'string') {
              return json(400, { error: 'uid, projectDir and homeDir are required' });
            }
            if (!Number.isInteger(uid) || uid < MIN_ISOLATED_UID) return json(400, { error: `uid must be an integer >= ${MIN_ISOLATED_UID}` });
            const known = store.get(projectId);
            if (!known) return json(409, { error: 'Unknown project: push its config (PUT) first' });
            if (known.uid !== uid) return json(409, { error: 'uid does not match the project' });
            const { warnings } = prepareProject({ projectId, uid, projectDir: body.projectDir, homeDir: body.homeDir }, { ...pathConfig, dev, mainGid: options.mainGid });
            return json(200, { ok: true, warnings });
          }
          const project = store.get(projectId);
          if (!project) return json(404, { error: 'Unknown project' });
          if (typeof body.runToken !== 'string' || !body.runToken) return json(400, { error: 'runToken is required' });
          if (!netState.ok) return json(503, { error: netState.reason ?? 'Network not ready' });
          if (typeof body.projectDir !== 'string') return json(400, { error: 'projectDir is required' });
          const homeDir = expectedHome(projectId, pathConfig);
          const tmp = path.join(homeDir, HOME_TMP_DIR);
          const request = {
            kind: 'exec' as const,
            projectId,
            uid: project.uid,
            projectDir: body.projectDir,
            homeDir,
            cwd: body.projectDir,
            args: [],
            env: {
              HTTPS_PROXY: `http://${projectId}:${project.proxySecret}@127.0.0.1:${boundProxyPort}`,
              HTTP_PROXY: `http://${projectId}:${project.proxySecret}@127.0.0.1:${boundProxyPort}`,
              NO_PROXY: '127.0.0.1,localhost',
              CLOUDCLI_RUN_TOKEN: body.runToken,
              TMPDIR: tmp,
              CLAUDE_CODE_TMPDIR: tmp,
            },
          };
          request.projectDir = request.cwd = validateSpawn(request, store, pathConfig); // same checks as any spawn
          const mainHome = options.mainHome ?? process.env.CLOUDCLI_MAIN_HOME;
          const mainHomePaths = ['/home/cloudcli/.cloudcli/auth.db', ...(mainHome ? [mainHome] : [])];
          const ctx: SelfCheckContext = {
            projectId,
            request,
            runToken: body.runToken,
            config: buildProbeConfig({ request, allowlist: project.allowlist, isolatedRoot: pathConfig.isolatedRoot, isolationDir: options.isolationDir, forwardPort: boundForwardPort, mainHomePaths }),
          };
          json(200, await (options.selfCheckRunner ?? ((c) => runProbeScript(c, hostOptions)))(ctx));
        } catch (error) {
          json(400, { error: (error as Error).message });
        }
      })();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/blocked') {
      return json(200, blocked.list(url.searchParams.get('projectId') ?? ''));
    }
    if (req.method === 'PUT' && projectMatch) {
      const projectId = decodeURIComponent(projectMatch[1]);
      if (!PROJECT_ID.test(projectId)) return json(400, { error: 'Invalid projectId' });
      void (async () => {
        try {
          const { config, error } = validateProjectConfig(JSON.parse(await readBody(req)));
          if (!config) return json(400, { error });
          const clash = store.uidOwner(config.uid, projectId);
          if (clash) return json(409, { error: `uid ${config.uid} is already used by project ${clash}` });
          store.set(projectId, config);
          await refreshNetwork();
          json(netState.ok ? 200 : 503, netState);
        } catch (error) {
          json(400, { error: (error as Error).message });
        }
      })();
      return;
    }
    json(404, { error: 'Not Found' });
  });

  const proxy = createEgressProxy({ getProject: (id) => store.get(id), blocked, httpPorts: options.proxyHttpPorts });
  const forward = createMainForward(options.mainSocketPath ?? path.join(options.isolationDir, 'main.sock'));
  const listenLoopback = (srv: http.Server, port: number) =>
    new Promise<number>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => resolve((srv.address() as net.AddressInfo).port));
    });

  server.on('upgrade', (req, duplex) => {
    const socket = duplex as import('node:net').Socket;
    const reject = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (!tokenMatches(req.headers.authorization, options.token)) return reject(401, 'Unauthorized');
    if (req.method !== 'POST' || req.url !== '/v1/spawn') return reject(404, 'Not Found');
    if (!netState.ok) return reject(503, 'Service Unavailable'); // fail closed: no firewall, no sandbox
    let spawnRequest;
    try {
      const header = req.headers['x-spawn'];
      if (typeof header !== 'string') throw new Error('missing X-Spawn');
      spawnRequest = parseSpawnRequest(JSON.parse(Buffer.from(header, 'base64').toString('utf8')));
    } catch {
      return reject(400, 'Bad Request');
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: cloudcli-sandbox\r\n\r\n');
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    try {
      spawnRequest = { ...spawnRequest, projectDir: validateSpawn(spawnRequest, store, pathConfig) }; // synchronous: no client frame can slip past before the host attaches
    } catch (error) {
      socket.write(encodeFrame('error', `Rejected: ${(error as Error).message}`));
      socket.end();
      return;
    }
    hostProcess(socket, spawnRequest, hostOptions);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  const boundForward = await listenLoopback(forward, forwardPort);
  const boundProxy = await listenLoopback(proxy, proxyPort);
  boundForwardPort = boundForward;
  boundProxyPort = boundProxy;
  await refreshNetwork();
  const timer = setInterval(() => void refreshNetwork(), options.resolveIntervalMs ?? 5 * 60_000);
  timer.unref();
  fs.chmodSync(socketPath, 0o660);
  if (!dev && options.mainGid !== undefined) {
    fs.chownSync(socketPath, process.getuid?.() ?? 0, options.mainGid);
  }

  return {
    socketPath,
    forwardPort: boundForward,
    proxyPort: boundProxy,
    close: () =>
      new Promise<void>((resolve) => {
        // Synchronous SIGKILL of every live group: must happen even if the process exits right after.
        for (const child of live) killGroup(child, 'SIGKILL');
        clearInterval(timer);
        for (const socket of sockets) socket.destroy();
        for (const srv of [forward, proxy]) {
          srv.close();
          srv.closeAllConnections();
        }
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const gid = process.env.CLOUDCLI_MAIN_GID;
  startDaemon({
    token: process.env.SANDBOX_DAEMON_TOKEN ?? '',
    isolationDir: process.env.ISOLATION_DIR ?? '/cloudcli-isolation',
    mainGid: gid ? Number(gid) : undefined, // validated in startDaemon
    isolatedRoot: process.env.ISOLATED_ROOT,
    isolatedHomes: process.env.ISOLATED_HOMES,
    version: process.env.SANDBOX_VERSION,
    dev: process.env.SANDBOX_DEV === '1',
    forwardPort: DEFAULT_FORWARD_PORT,
    proxyPort: DEFAULT_PROXY_PORT,
  }).then(
    (daemon) => {
      console.log(`sandbox daemon listening on ${daemon.socketPath}`);
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.once(signal, () => {
          void daemon.close().finally(() => process.exit(0));
        });
      }
    },
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}

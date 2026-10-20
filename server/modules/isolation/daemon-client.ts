// App side of the sandbox daemon (daemon/daemon.ts): HTTP over <ISOLATION_DIR>/daemon.sock with the shared token.
// `spawn` returns a SandboxProcess that satisfies the Agent SDK's SpawnedProcess, so the Claude runtime can hand
// it to `spawnClaudeCodeProcess` unchanged.
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { Readable, Writable, type Duplex } from 'node:stream';

import type { BlockedEntry } from '@/modules/isolation/daemon/egress-proxy.js';
import { encodeFrame, FrameDecoder } from '@/modules/isolation/daemon/frames.js';
import type { SpawnRequest } from '@/modules/isolation/daemon/process-host.js';
import type { SelfCheckResult } from '@/modules/isolation/daemon/self-check.js';
import { daemonSocketPath, isolationConfig } from '@/modules/isolation/isolation.config.js';
import type { IsolatedProject } from '@/modules/isolation/isolation.db.js';

export type { SpawnRequest } from '@/modules/isolation/daemon/process-host.js';
export type { BlockedEntry } from '@/modules/isolation/daemon/egress-proxy.js';
export type { SelfCheckResult } from '@/modules/isolation/daemon/self-check.js';

/** Start of every error a run of an isolated project fails with when the sandbox cannot be reached. */
export const SANDBOX_DOWN_TEXT = 'Sandbox izolovaného projektu neběží';

export type DaemonEndpoint = { socketPath: string; token: string } | { error: string };

export type DaemonStatus = {
  /** The daemon answered at all. */
  running: boolean;
  /** Running and its firewall is in place (spawns are accepted). */
  ok: boolean;
  reason?: string;
  version?: string;
  claudeVersion?: string;
  projects?: number;
};

export class DaemonCallError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'DaemonCallError';
  }
}

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 15_000;
const SELF_CHECK_TIMEOUT_MS = 90_000;

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

/**
 * One process in the sandbox, bridged over the framed upgrade connection. Mirrors the parts of ChildProcess the
 * SDK uses: stdin/stdout, killed, exitCode, kill(), 'exit' and 'error'. stderr is a separate stream (flowing, so
 * unread output is dropped instead of buffered). Failure to reach the daemon, a rejection, or the daemon going
 * away mid-run all end as 'error' followed by 'exit' with code 1 — never a silent hang.
 */
export class SandboxProcess extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: undefined = undefined;

  private socket: Duplex | null = null;
  private pending: Buffer[] = [];
  private exited = false;
  private errored = false;
  private killedFlag = false;
  private code: number | null = null;

  constructor(connect: () => Promise<Duplex>) {
    super();
    this.stdout = new Readable({ read: () => this.socket?.resume() });
    this.stderr = new Readable({ read: () => {} });
    this.stderr.resume();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => this.send(encodeFrame('stdin', chunk), callback),
      // A socket half-close would kill the process in the daemon; end of input is a frame of its own.
      final: (callback) => this.send(encodeFrame('stdin_end'), callback),
    });

    connect().then(
      (socket) => this.attach(socket),
      (error: unknown) => this.fail(error instanceof Error ? error.message : String(error)),
    );
  }

  get killed(): boolean {
    return this.killedFlag;
  }

  get exitCode(): number | null {
    return this.code;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exited) return false;
    this.killedFlag = true;
    this.send(encodeFrame('kill', signal), () => {});
    return true;
  }

  override on(event: 'exit', listener: ExitListener): this;
  override on(event: 'error', listener: (error: Error) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override once(event: 'exit', listener: ExitListener): this;
  override once(event: 'error', listener: (error: Error) => void): this;
  override once(event: string | symbol, listener: (...args: any[]) => void): this;
  override once(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  private send(frame: Buffer, callback: () => void): void {
    if (this.exited) return callback();
    if (!this.socket) {
      this.pending.push(frame);
      return callback();
    }
    if (this.socket.write(frame)) callback();
    else this.socket.once('drain', callback);
  }

  private attach(socket: Duplex): void {
    if (this.exited) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    for (const frame of this.pending.splice(0)) socket.write(frame);
    const decoder = new FrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        this.fail(`invalid data from the sandbox: ${(error as Error).message}`);
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.type === 'stdout') {
          if (!this.stdout.push(frame.payload)) socket.pause();
        } else if (frame.type === 'stderr') {
          this.stderr.push(frame.payload);
        } else if (frame.type === 'error') {
          this.emitError(new Error(`Sandbox: ${frame.payload.toString('utf8')}`));
        } else if (frame.type === 'exit') {
          let parsed: { code?: number | null; signal?: NodeJS.Signals | null } = {};
          try {
            parsed = JSON.parse(frame.payload.toString('utf8'));
          } catch {
            // treated as an unknown exit below
          }
          const signal = parsed.signal ?? null;
          this.finish(signal ? null : (typeof parsed.code === 'number' ? parsed.code : 1), signal);
          socket.end();
        }
      }
    });
    socket.on('error', () => {
      // 'close' follows and reports it.
    });
    socket.on('close', () => {
      if (this.exited) return;
      if (this.errored) this.finish(1, null); // the daemon already said why (rejected spawn)
      else this.fail('the connection to the sandbox was lost');
    });
  }

  private emitError(error: Error): void {
    this.errored = true;
    if (this.listenerCount('error') > 0) this.emit('error', error);
    else console.warn(`[Isolation] ${error.message}`);
  }

  private fail(detail: string): void {
    if (this.exited) return;
    this.emitError(new Error(`${SANDBOX_DOWN_TEXT} (${detail})`));
    this.finish(1, null);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.code = code;
    this.pending = [];
    this.stdout.push(null);
    this.stderr.push(null);
    // After the stdout end is queued, so readers see all output before 'exit'.
    setImmediate(() => {
      this.emit('exit', code, signal);
      this.emit('close', code, signal);
    });
  }
}

function openSpawn(socketPath: string, token: string, request: SpawnRequest): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      method: 'POST',
      path: '/v1/spawn',
      agent: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'cloudcli-sandbox',
        Authorization: `Bearer ${token}`,
        'X-Spawn': Buffer.from(JSON.stringify(request)).toString('base64'),
      },
    });
    const timer = setTimeout(() => req.destroy(new Error('the sandbox daemon did not answer')), CONNECT_TIMEOUT_MS);
    req.on('upgrade', (_res, socket, head) => {
      clearTimeout(timer);
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    req.on('response', (res) => {
      clearTimeout(timer);
      res.resume();
      reject(new Error(`the daemon refused the start: HTTP ${res.statusCode ?? 0}`));
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}

function callJson<T>(endpoint: DaemonEndpoint, method: string, urlPath: string, body?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<{ status: number; body: T }> {
  if ('error' in endpoint) return Promise.reject(new DaemonCallError(0, `${SANDBOX_DOWN_TEXT} (${endpoint.error})`));
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: endpoint.socketPath,
        method,
        path: urlPath,
        agent: false,
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timer);
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
          } catch {
            // non-JSON body: status alone decides
          }
          resolve({ status: res.statusCode ?? 0, body: parsed as T });
        });
        res.on('error', reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error('the sandbox daemon did not answer in time')), timeoutMs);
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(new DaemonCallError(0, `${SANDBOX_DOWN_TEXT} (${error.message})`));
    });
    req.end(payload);
  });
}

function expectOk<T>(result: { status: number; body: T }): T {
  if (result.status >= 200 && result.status < 300) return result.body;
  const message = (result.body as { error?: string; reason?: string } | null)?.error
    ?? (result.body as { reason?: string } | null)?.reason
    ?? `HTTP ${result.status}`;
  throw new DaemonCallError(result.status, `Sandbox daemon: ${message}`);
}

const projectPath = (projectId: string, action?: string) =>
  `/v1/projects/${encodeURIComponent(projectId)}${action ? `/${action}` : ''}`;

export function createDaemonClient(resolveEndpoint: () => DaemonEndpoint) {
  return {
    spawn(request: SpawnRequest): SandboxProcess {
      const endpoint = resolveEndpoint();
      return new SandboxProcess(() =>
        'error' in endpoint
          ? Promise.reject(new Error(endpoint.error))
          : openSpawn(endpoint.socketPath, endpoint.token, request),
      );
    },

    /** Pushes uid, name, allowlist and proxy secret; the daemon rebuilds its firewall. 409 when the uid is taken. */
    async putProject(project: IsolatedProject): Promise<{ ok: true }> {
      expectOk(await callJson(resolveEndpoint(), 'PUT', projectPath(project.projectId), {
        uid: project.uid,
        name: project.name,
        allowlist: project.allowlist,
        proxySecret: project.proxySecret,
      }));
      return { ok: true };
    },

    /** Ownership/modes of the project dir and home, minimal .claude.json. 409 unless putProject ran with the same uid. */
    async prepare(project: IsolatedProject): Promise<{ ok: boolean; warnings: string[] }> {
      const body = expectOk(await callJson<{ ok: boolean; warnings?: string[] }>(resolveEndpoint(), 'POST', projectPath(project.projectId, 'prepare'), {
        uid: project.uid,
        projectDir: project.projectPath,
        homeDir: project.homeDir,
      }));
      return { ok: Boolean(body?.ok), warnings: body?.warnings ?? [] };
    },

    /** Gives files the app wrote into the project (paths relative to it) to the project uid; never follows symlinks. */
    async adopt(project: IsolatedProject, paths: string[]): Promise<{ ok: boolean; warnings: string[] }> {
      const body = expectOk(await callJson<{ ok: boolean; warnings?: string[] }>(resolveEndpoint(), 'POST', projectPath(project.projectId, 'adopt'), {
        uid: project.uid,
        projectDir: project.projectPath,
        paths,
      }));
      return { ok: Boolean(body?.ok), warnings: body?.warnings ?? [] };
    },

    async selfCheck(projectId: string, runToken: string, projectDir: string): Promise<SelfCheckResult> {
      const body = expectOk(await callJson<SelfCheckResult>(resolveEndpoint(), 'POST', projectPath(projectId, 'self-check'), { runToken, projectDir }, SELF_CHECK_TIMEOUT_MS));
      return { checks: Array.isArray(body?.checks) ? body.checks : [] };
    },

    async blocked(projectId: string): Promise<BlockedEntry[]> {
      const body = expectOk(await callJson<BlockedEntry[]>(resolveEndpoint(), 'GET', `/v1/blocked?projectId=${encodeURIComponent(projectId)}`));
      return Array.isArray(body) ? body : [];
    },

    /** Never throws: an unreachable daemon is `running: false` with the reason. */
    async status(): Promise<DaemonStatus> {
      try {
        const { status, body } = await callJson<Omit<DaemonStatus, 'running'> | { error?: string }>(resolveEndpoint(), 'GET', '/v1/status');
        if (status === 401) return { running: true, ok: false, reason: 'The sandbox daemon rejected the app token (CLOUDCLI_SANDBOX_DAEMON_TOKEN mismatch).' };
        const data = (body ?? {}) as Omit<DaemonStatus, 'running'>;
        return {
          running: true,
          ok: status === 200 && data.ok !== false,
          ...(data.reason ? { reason: data.reason } : {}),
          version: data.version,
          claudeVersion: data.claudeVersion,
          projects: data.projects,
        };
      } catch (error) {
        return { running: false, ok: false, reason: (error as Error).message };
      }
    },
  };
}

export type DaemonClient = ReturnType<typeof createDaemonClient>;

function endpointFromConfig(): DaemonEndpoint {
  const config = isolationConfig();
  if (!config.available) return { error: config.reason ?? 'isolation is not configured' };
  return { socketPath: daemonSocketPath(config), token: config.daemonToken };
}

/** The app's client; its methods can be replaced in tests (`mock.method(daemonClient, ...)`). */
export const daemonClient: DaemonClient = createDaemonClient(endpointFromConfig);

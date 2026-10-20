// Spawns one process for a client connection and bridges it to frames.
// Node builtins only (runs standalone in the sandbox image).
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';

import { FrameDecoder, encodeFrame, type Frame } from './frames.js';
import { PROJECT_ID } from './project-store.js';

export type SpawnKind = 'claude' | 'exec' | 'pty';

export type SpawnRequest = {
  kind: SpawnKind;
  projectId: string;
  uid: number;
  projectDir: string;
  homeDir: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
};

export type ProcessHostOptions = {
  dev: boolean;
  /** Executable for kind 'claude'. */
  claudeBin: string;
  /** Group the process runs as in production. Defaults to uid. */
  gidFor?: (uid: number) => number;
  killGraceMs?: number;
  /** Live children of this daemon, so shutdown can kill every group. */
  live?: Set<ChildProcess>;
  /** Tests only: replaces child_process.spawn. */
  spawnImpl?: typeof spawn;
  /** Loads node-pty for kind 'pty' (only then; the daemon imports nothing but builtins otherwise). Tests replace it. */
  loadPty?: () => Promise<PtyModule>;
};

/** The part of node-pty the daemon uses. */
export type PtyModule = {
  spawn(file: string, args: string[], options: Record<string, unknown>): PtyProcess;
};
export type PtyProcess = {
  pid: number;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
};

async function defaultLoadPty(): Promise<PtyModule> {
  // A variable specifier keeps the import dynamic and optional: an image without node-pty only loses terminals.
  const name = 'node-pty';
  const mod = (await import(name)) as { default?: PtyModule } & Partial<PtyModule>;
  const resolved = typeof mod.spawn === 'function' ? (mod as PtyModule) : mod.default;
  if (!resolved || typeof resolved.spawn !== 'function') throw new Error('node-pty has no spawn');
  return resolved;
}

const SIGNAL_NAMES = new Map<number, NodeJS.Signals>(
  (Object.entries(os.constants.signals) as [NodeJS.Signals, number][]).map(([name, number]) => [number, name]),
);

/** Internal override (never reachable from a client request): run this exact command instead of claude/bash. */
export type CommandOverride = { command: string; args: string[] };

const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';
const MIN_ISOLATED_UID = 20000;

export function parseSpawnRequest(raw: unknown): SpawnRequest {
  const req = raw as Partial<SpawnRequest> | null;
  if (!req || typeof req !== 'object') throw new Error('Invalid spawn request');
  if (req.kind !== 'claude' && req.kind !== 'exec' && req.kind !== 'pty') {
    throw new Error('Invalid kind');
  }
  if (typeof req.uid !== 'number' || !Number.isInteger(req.uid) || req.uid < 0) {
    throw new Error('Invalid uid');
  }
  if (typeof req.projectId !== 'string' || !PROJECT_ID.test(req.projectId)) throw new Error('Invalid projectId');
  for (const key of ['projectDir', 'homeDir', 'cwd'] as const) {
    if (typeof req[key] !== 'string' || !req[key]) throw new Error(`Invalid ${key}`);
  }
  if (!Array.isArray(req.args) || req.args.some((a) => typeof a !== 'string')) {
    throw new Error('Invalid args');
  }
  if (
    !req.env ||
    typeof req.env !== 'object' ||
    Object.values(req.env).some((v) => typeof v !== 'string')
  ) {
    throw new Error('Invalid env');
  }
  return req as SpawnRequest;
}

export function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** Bridges `socket` (already upgraded) to a freshly spawned process. */
export function hostProcess(socket: Duplex, req: SpawnRequest, options: ProcessHostOptions, override?: CommandOverride): void {
  const fail = (message: string) => {
    socket.write(encodeFrame('error', message));
    socket.end();
  };

  if (!options.dev && req.uid < MIN_ISOLATED_UID) {
    fail('uid below isolated range');
    return;
  }

  // pty: args[0] is the command line ("-c" like the local terminal); empty = an interactive login shell.
  const ptyArgs = (req.args[0] ?? '') === '' ? ['-l'] : ['-c', req.args[0]];
  let command = override?.command ?? (req.kind === 'claude' ? options.claudeBin : 'bash');
  let args = override?.args ?? (req.kind === 'claude' ? req.args : req.kind === 'pty' ? ptyArgs : ['-lc', req.args[0] ?? '']);
  // The process is created in projectDir (its parent is root-owned, so it cannot be swapped). The requested
  // subdirectory is entered only after the uid drop, so the kernel checks the project's own permissions
  // and a symlink planted in the project cannot redirect a root chdir().
  if (path.resolve(req.cwd) !== path.resolve(req.projectDir)) {
    args = ['-c', 'cd -P -- "$1" || exit 126; shift; exec "$@"', 'sh', req.cwd, command, ...args];
    command = '/bin/sh';
  }
  // Exactly what the client sent, plus PATH and HOME. Never the daemon's own env.
  const env: Record<string, string> = {
    PATH: DEFAULT_PATH,
    ...req.env,
    HOME: req.homeDir,
  };

  const drop = options.dev ? {} : { uid: req.uid, gid: options.gidFor ? options.gidFor(req.uid) : req.uid };
  if (req.kind === 'pty') {
    hostPty(socket, req, command, args, env, drop, options, fail);
    return;
  }

  let child: ChildProcess;
  try {
    child = (options.spawnImpl ?? spawn)(command, args, {
      cwd: req.projectDir,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...drop,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  options.live?.add(child);
  child.once('close', () => options.live?.delete(child));
  child.once('error', () => options.live?.delete(child));

  let finished = false;
  let killTimer: NodeJS.Timeout | undefined;
  const grace = options.killGraceMs ?? 3000;

  const terminate = () => {
    if (finished) return;
    killGroup(child, 'SIGTERM');
    killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), grace);
    killTimer.unref();
  };

  child.on('error', (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(killTimer);
    socket.write(encodeFrame('error', error.message));
    socket.end();
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    if (!socket.write(encodeFrame('stdout', chunk))) {
      child.stdout?.pause();
      socket.once('drain', () => child.stdout?.resume());
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (!socket.write(encodeFrame('stderr', chunk))) {
      child.stderr?.pause();
      socket.once('drain', () => child.stderr?.resume());
    }
  });
  child.stdin?.on('error', () => {});

  child.on('close', (code, signal) => {
    if (finished) return;
    finished = true;
    clearTimeout(killTimer);
    // Sweep leftovers of the group (grandchildren) once the leader is gone.
    killGroup(child, 'SIGKILL');
    socket.write(encodeFrame('exit', JSON.stringify({ code, signal })));
    socket.end();
  });

  const decoder = new FrameDecoder();
  socket.on('data', (chunk: Buffer) => {
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch {
      terminate();
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      if (frame.type === 'stdin') child.stdin?.write(frame.payload);
      else if (frame.type === 'stdin_end') child.stdin?.end();
      else if (frame.type === 'kill') {
        killGroup(child, (frame.payload.toString('utf8') || 'SIGTERM') as NodeJS.Signals);
      }
      // 'resize' only matters for kind 'pty'.
    }
  });
  socket.on('error', () => {});
  // http.Server sockets are half-open capable: a client FIN only emits 'end', never 'close'.
  socket.on('end', () => {
    terminate();
    socket.destroy();
  });
  socket.on('close', terminate);
}

/**
 * kind 'pty': the process runs on a pseudo terminal (node-pty), as the project's uid like every other kind. The
 * terminal merges stdout and stderr, so output is 'stdout' frames; 'resize' carries {cols, rows}. Frames that
 * arrive while node-pty is still loading are queued.
 */
function hostPty(
  socket: Duplex,
  req: SpawnRequest,
  command: string,
  args: string[],
  env: Record<string, string>,
  drop: { uid?: number; gid?: number },
  options: ProcessHostOptions,
  fail: (message: string) => void,
): void {
  let term: PtyProcess | null = null;
  let finished = false;
  let closed = false;
  let killTimer: NodeJS.Timeout | undefined;
  const queue: Frame[] = [];
  const grace = options.killGraceMs ?? 3000;
  // Lets the daemon's shutdown sweep treat the terminal like any child (killGroup needs only pid and kill).
  const handle = { get pid() { return term?.pid; }, kill: (signal?: NodeJS.Signals) => term?.kill(signal) } as unknown as ChildProcess;
  const groupKill = (signal: NodeJS.Signals) => {
    if (term) killGroup(handle, signal);
  };
  const terminate = () => {
    closed = true;
    if (!term || finished) return;
    groupKill('SIGTERM');
    killTimer = setTimeout(() => groupKill('SIGKILL'), grace);
    killTimer.unref();
  };

  const apply = (frame: Frame) => {
    if (!term) return;
    if (frame.type === 'stdin') term.write(frame.payload);
    else if (frame.type === 'kill') groupKill((frame.payload.toString('utf8') || 'SIGTERM') as NodeJS.Signals);
    else if (frame.type === 'resize') {
      try {
        const size = JSON.parse(frame.payload.toString('utf8')) as { cols?: unknown; rows?: unknown };
        const { cols, rows } = size;
        if (Number.isInteger(cols) && Number.isInteger(rows) && (cols as number) > 0 && (rows as number) > 0 && (cols as number) < 1000 && (rows as number) < 1000) {
          term.resize(cols as number, rows as number);
        }
      } catch {
        // A malformed size is ignored.
      }
    }
    // 'stdin_end' has no meaning for a terminal.
  };

  const decoder = new FrameDecoder();
  socket.on('data', (chunk: Buffer) => {
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch {
      terminate();
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      if (term) apply(frame);
      else queue.push(frame);
    }
  });
  socket.on('error', () => {});
  socket.on('end', () => {
    terminate();
    socket.destroy();
  });
  socket.on('close', terminate);

  (options.loadPty ?? defaultLoadPty)().then(
    (ptyModule) => {
      if (closed) return;
      try {
        term = ptyModule.spawn(command, args, {
          name: env.TERM || 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: req.projectDir,
          env,
          ...drop,
        });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
        return;
      }
      options.live?.add(handle);
      term.onData((data) => {
        socket.write(encodeFrame('stdout', Buffer.from(data, 'utf8')));
      });
      term.onExit(({ exitCode, signal }) => {
        if (finished) return;
        finished = true;
        clearTimeout(killTimer);
        options.live?.delete(handle);
        groupKill('SIGKILL'); // leftovers of the terminal's session
        const name = signal ? (SIGNAL_NAMES.get(signal) ?? null) : null;
        socket.write(encodeFrame('exit', JSON.stringify({ code: name ? null : exitCode, signal: name })));
        socket.end();
      });
      for (const frame of queue.splice(0)) apply(frame);
    },
    () => fail('pty not supported: node-pty is not available in the sandbox'),
  );
}

// Spawns one process for a client connection and bridges it to frames.
// Node builtins only (runs standalone in the sandbox image).
import { spawn, type ChildProcess } from 'node:child_process';
import type { Duplex } from 'node:stream';

import { FrameDecoder, encodeFrame } from './frames.js';

export type SpawnKind = 'claude' | 'exec' | 'pty';

export type SpawnRequest = {
  kind: SpawnKind;
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
};

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

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
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
export function hostProcess(socket: Duplex, req: SpawnRequest, options: ProcessHostOptions): void {
  const fail = (message: string) => {
    socket.write(encodeFrame('error', message));
    socket.end();
  };

  if (req.kind === 'pty') {
    fail('pty not supported yet');
    return;
  }
  if (!options.dev && req.uid < MIN_ISOLATED_UID) {
    fail('uid below isolated range');
    return;
  }

  const command = req.kind === 'claude' ? options.claudeBin : 'bash';
  const args = req.kind === 'claude' ? req.args : ['-lc', req.args[0] ?? ''];
  // Exactly what the client sent, plus PATH and HOME. Never the daemon's own env.
  const env: Record<string, string> = {
    PATH: DEFAULT_PATH,
    ...req.env,
    HOME: req.homeDir,
  };

  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      cwd: req.cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.dev ? {} : { uid: req.uid, gid: options.gidFor ? options.gidFor(req.uid) : req.uid }),
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

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
      // 'resize' only matters for pty (Task 8).
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

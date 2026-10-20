// Schedule scripts and terminals of isolated projects: run by the sandbox daemon as the project's uid (kinds
// 'exec' and 'pty'), with the allowlisted sandbox env. Callers decide with isIsolatedPath; anything that goes wrong
// for an isolated project is an error, never a local process.
import os from 'node:os';

import { buildSandboxEnv } from '@/modules/isolation/claude-sandbox-options.js';
import { daemonClient, SANDBOX_DOWN_TEXT, type SandboxProcess } from '@/modules/isolation/daemon-client.js';
import { isolationConfig } from '@/modules/isolation/isolation.config.js';
import { isolationDb, type IsolatedProject } from '@/modules/isolation/isolation.db.js';
import { runTokens, type RunTokenPurpose } from '@/modules/isolation/run-tokens.js';

const DEFAULT_KILL_GRACE_MS = 5_000;
/** After the process ended, how long its remaining output may still arrive. */
const DRAIN_MS = 500;

export const TERMINAL_UNAVAILABLE_TEXT = 'Terminál izolovaného projektu zatím není k dispozici';
const NOT_A_PROJECT_TEXT = 'Tato cesta patří do izolované oblasti, ale nepatří k izolovanému projektu — nespustí se.';

/** The isolated project for `projectPath`, or a thrown error (fail closed) when it cannot run in the sandbox. */
function requireSandboxProject(projectPath: string): IsolatedProject {
  const config = isolationConfig();
  if (!config.available) throw new Error(`${SANDBOX_DOWN_TEXT} (${config.reason ?? 'isolation is not configured'})`);
  const project = isolationDb.getByPath(projectPath);
  if (!project) throw new Error(NOT_A_PROJECT_TEXT);
  if (!project.homeDir) throw new Error(`${SANDBOX_DOWN_TEXT} (CLOUDCLI_ISOLATED_HOMES is not set)`);
  return project;
}

export type SandboxExecResult = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** `abort` was called. */
  aborted: boolean;
};

/**
 * Runs `command` with `bash -lc` in the sandbox, in `projectPath` (the project or a directory below it). `env`
 * is added to the sandbox allowlist env (no Claude login). Resolves when the process ended; a sandbox that cannot
 * be reached is reported through onStderr and resolves with exitCode null. Throws when the project cannot run in
 * the sandbox at all.
 */
export async function runInSandbox(opts: {
  projectPath: string;
  command: string;
  env?: Record<string, string>;
  timeoutMs: number;
  killGraceMs?: number;
  /** Aborting kills the process like a timeout does. */
  signal?: AbortSignal;
  sessionId?: string;
  onStdout: (text: string) => void;
  onStderr: (text: string) => void;
}): Promise<SandboxExecResult> {
  const project = requireSandboxProject(opts.projectPath);
  const runToken = runTokens.mint({ projectId: project.projectId, sessionId: opts.sessionId ?? '', purpose: 'exec' });
  try {
    const env = buildSandboxEnv(project, runToken, opts.env ?? {}, { claude: false });
    const proc = daemonClient.spawn({
      kind: 'exec',
      projectId: project.projectId,
      uid: project.uid,
      projectDir: project.projectPath,
      homeDir: project.homeDir,
      cwd: opts.projectPath,
      args: [opts.command],
      env,
    });

    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | null = null;
    const terminate = () => {
      proc.kill('SIGTERM');
      if (!killTimer) killTimer = setTimeout(() => proc.kill('SIGKILL'), opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (text: string) => opts.onStdout(text));
    proc.stderr.on('data', (text: string) => opts.onStderr(text));
    proc.on('error', (error: Error) => opts.onStderr(`${error.message}\n`));

    try {
      const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        proc.once('exit', (code, signal) => resolve({ code, signal }));
      });
      // stdout/stderr end before 'exit' is emitted, but their last chunks may still be queued.
      await Promise.all([proc.stdout, proc.stderr].map((stream) => new Promise<void>((resolve) => {
        if (stream.readableEnded) return resolve();
        const timer = setTimeout(resolve, DRAIN_MS);
        stream.once('end', () => {
          clearTimeout(timer);
          resolve();
        });
      })));
      return { exitCode: code, signal, timedOut, aborted };
    } finally {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  } finally {
    runTokens.revoke(runToken);
  }
}

/** The part of node-pty's IPty the shell websocket uses; a terminal in the sandbox satisfies it too. */
export type ShellPty = {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
};

export type SandboxTerminal = ShellPty & { process: SandboxProcess };

/**
 * Starts a terminal in the sandbox: a login shell running `command` (empty = an interactive shell) on a pty,
 * as the project's uid, in `cwd`. `claude: true` is for a Claude CLI: its env gets the Claude proxy login and the
 * token is minted for purpose 'claude' bound to `sessionId`; otherwise purpose 'pty' and no Claude login.
 * The token is revoked when the terminal exits. Throws when the project cannot run in the sandbox at all; a
 * sandbox that cannot be reached ends the terminal with `SANDBOX_DOWN_TEXT` in the data stream.
 */
export function startSandboxTerminal(opts: {
  projectPath: string;
  cwd?: string;
  command: string;
  cols: number;
  rows: number;
  claude: boolean;
  sessionId?: string;
  env?: Record<string, string>;
}): SandboxTerminal {
  const project = requireSandboxProject(opts.projectPath);
  const purpose: RunTokenPurpose = opts.claude ? 'claude' : 'pty';
  const runToken = runTokens.mint({ projectId: project.projectId, sessionId: opts.sessionId ?? '', purpose });
  let proc: SandboxProcess;
  try {
    const env = buildSandboxEnv(
      project,
      runToken,
      { COLORTERM: 'truecolor', FORCE_COLOR: '3', ...opts.env },
      { claude: opts.claude },
    );
    proc = daemonClient.spawn({
      kind: 'pty',
      projectId: project.projectId,
      uid: project.uid,
      projectDir: project.projectPath,
      homeDir: project.homeDir,
      cwd: opts.cwd ?? opts.projectPath,
      args: [opts.command],
      env,
    });
  } catch (error) {
    runTokens.revoke(runToken);
    throw error;
  }
  proc.once('exit', () => runTokens.revoke(runToken));
  proc.resize(opts.cols, opts.rows);

  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (data: string) => dataListeners.forEach((listener) => listener(data)));
  proc.stderr.on('data', () => {});
  // A rejected spawn or a lost daemon: show why in the terminal itself. A daemon without pty support gets the
  // plain refusal text, the technical detail on a second line.
  proc.on('error', (error: Error) => {
    const text = /pty not supported/i.test(error.message) ? `${TERMINAL_UNAVAILABLE_TEXT}\r\n${error.message}` : error.message;
    dataListeners.forEach((listener) => listener(`\r\n\x1b[31m${text}\x1b[0m\r\n`));
  });
  // A signal or a lost daemon is never reported as success.
  proc.once('exit', (code, signal) => {
    const exitCode = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1);
    exitListeners.forEach((listener) => listener({ exitCode }));
  });

  return {
    process: proc,
    onData: (listener) => {
      dataListeners.push(listener);
      return { dispose: () => undefined };
    },
    onExit: (listener) => {
      exitListeners.push(listener);
      return { dispose: () => undefined };
    },
    write: (data) => {
      proc.stdin.write(data);
    },
    resize: (cols, rows) => proc.resize(cols, rows),
    kill: (signal) => {
      proc.kill((signal as NodeJS.Signals | undefined) ?? 'SIGTERM');
    },
  };
}

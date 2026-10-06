import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { channelsService } from '@/modules/channels/index.js';
import type { ScheduleRow } from '@/modules/database/index.js';

/** Full output of every script run, one file per run; pruned together with the runs. */
export const SCHEDULE_LOGS_DIR = path.join(os.homedir(), '.cloudcli', 'schedules', 'logs');

/** What the run row keeps of a script's output: the end, where errors usually are. */
const OUTPUT_TAIL_CHARS = 64 * 1024;
const LOG_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 10_000;
/** After bash exits, how long background children may keep its pipes before we stop reading. */
const DRAIN_AFTER_EXIT_MS = 1_500;

/** Scripts running right now, by run id — so deleting a schedule can stop them. */
const runningScripts = new Map<string, { stop: () => void; logPath: string }>();

/**
 * Used by the schedules service when a schedule is deleted mid-run: stops the
 * given runs' scripts (whole process group) and returns their log paths.
 */
export function stopScriptRuns(runIds: string[]): string[] {
  const logs: string[] = [];
  for (const runId of runIds) {
    const entry = runningScripts.get(runId);
    if (!entry) continue;
    entry.stop();
    logs.push(entry.logPath);
  }
  return logs;
}

export type ScriptResult = {
  status: 'succeeded' | 'failed' | 'timeout';
  exitCode: number | null;
  /** Tail of stdout alone — what a hand-off gives the agent. */
  stdout: string;
  /** Tail of stdout and stderr interleaved — what the run shows. */
  output: string;
  logPath: string;
};

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > OUTPUT_TAIL_CHARS ? next.slice(-OUTPUT_TAIL_CHARS) : next;
}

/**
 * Used by the schedule executor: runs the schedule's command with `bash -lc`
 * in its project, in its own process group so a timeout kills the children
 * too (SIGTERM, then SIGKILL after a grace period).
 */
export async function runScript(input: {
  schedule: ScheduleRow;
  runId: string;
  scheduledFor: string | null;
  logsDir?: string;
  timeoutSec?: number;
  killGraceMs?: number;
}): Promise<ScriptResult> {
  const { schedule } = input;
  const logsDir = input.logsDir ?? SCHEDULE_LOGS_DIR;
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `${input.runId}.log`);
  const log = fs.createWriteStream(logPath);
  // A log that cannot be written (full disk, permissions) must not take the server down;
  // the run still keeps its output tail in the database.
  let logBroken = false;
  log.on('error', (error) => {
    logBroken = true;
    console.warn(`[Schedules] Cannot write run log ${logPath}: ${error.message}`);
  });
  const writeLog = (text: string) => {
    if (!logBroken) log.write(text);
  };
  const closeLog = () => new Promise<void>((resolve) => {
    if (logBroken || log.destroyed) {
      resolve();
      return;
    }
    log.once('close', () => resolve());
    log.once('error', () => resolve());
    log.end();
  });
  writeLog(`$ ${schedule.command}\n# cwd: ${schedule.project_path}\n# started: ${new Date().toISOString()}\n\n`);

  if (!fs.existsSync(schedule.project_path)) {
    const message = `The project directory ${schedule.project_path} does not exist.`;
    writeLog(`${message}\n`);
    await closeLog();
    return { status: 'failed', exitCode: null, stdout: '', output: message, logPath };
  }

  const publicUrl = channelsService.getPublicUrl();
  const child = spawn('bash', ['-lc', schedule.command], {
    cwd: schedule.project_path,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLOUDCLI_SCHEDULE_ID: schedule.id,
      CLOUDCLI_SCHEDULE_NAME: schedule.name,
      CLOUDCLI_RUN_ID: input.runId,
      CLOUDCLI_SCHEDULED_FOR: input.scheduledFor ?? '',
      ...(publicUrl ? { CLOUDCLI_PUBLIC_URL: publicUrl } : {}),
    },
  });

  let output = '';
  let stdout = '';
  let loggedBytes = 0;
  let logTruncated = false;
  const record = (text: string, isStdout: boolean) => {
    output = appendTail(output, text);
    if (isStdout) stdout = appendTail(stdout, text);
    if (loggedBytes < LOG_LIMIT_BYTES) {
      writeLog(text);
      loggedBytes += Buffer.byteLength(text);
    } else if (!logTruncated) {
      logTruncated = true;
      writeLog('\n[log truncated at 1 MiB — the run keeps the last 64 KiB]\n');
    }
  };
  // Decode as UTF-8 streams so a character split between two chunks stays whole.
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (text: string) => record(text, true));
  child.stderr?.on('data', (text: string) => record(text, false));

  const killGroup = (signal: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
  };
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  runningScripts.set(input.runId, {
    logPath,
    stop: () => {
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), input.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    },
  });
  const timeoutMs = Math.max(1, input.timeoutSec ?? schedule.timeout_sec) * 1000;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    killGroup('SIGTERM');
    killTimer = setTimeout(() => killGroup('SIGKILL'), input.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
  }, timeoutMs);

  // The run ends when bash exits, not when every holder of its pipes is gone:
  // a background child (`daemon &`, setsid) would otherwise keep it open forever.
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      output = appendTail(output, `\n${error.message}\n`);
      resolve(null);
    });
    child.once('exit', (code) => resolve(code));
  });
  await new Promise<void>((resolve) => {
    if (child.stdout?.readableEnded !== false && child.stderr?.readableEnded !== false) {
      resolve();
      return;
    }
    const drainTimer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve();
    }, DRAIN_AFTER_EXIT_MS);
    child.once('close', () => {
      clearTimeout(drainTimer);
      resolve();
    });
  });
  clearTimeout(timeoutTimer);
  if (killTimer) clearTimeout(killTimer);
  runningScripts.delete(input.runId);

  const status: ScriptResult['status'] = timedOut ? 'timeout' : exitCode === 0 ? 'succeeded' : 'failed';
  writeLog(`\n# finished: ${new Date().toISOString()} · ${status}${exitCode === null ? '' : ` · exit ${exitCode}`}\n`);
  await closeLog();
  return { status, exitCode, stdout, output, logPath };
}

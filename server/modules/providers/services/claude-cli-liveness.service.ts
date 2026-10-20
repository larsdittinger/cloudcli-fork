import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { isIsolatedPath } from '@/modules/isolation/index.js';
import {
  getActiveClaudeSDKSessions,
  getClaudeSDKSessionStartTime,
  isClaudeSDKSessionMidTurn,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';

/**
 * One Claude CLI process that is currently producing a response.
 *
 * `providerSessionId` is Claude's own session id, which is what the registry
 * records; callers map it onto an app session themselves.
 */
type LiveClaudeCliSession = {
  providerSessionId: string;
  startedAt: number;
};

/**
 * Claude Code keeps one file per running session here, named `<pid>.json`.
 * The directory belongs to the CLI, not to CloudCLI: it is only ever read.
 */
const registryDirectory = () => path.join(os.homedir(), '.claude', 'sessions');

/**
 * Upper bound on registry files inspected per poll.
 *
 * The running-sessions endpoint is polled continuously, so a directory left
 * full of stale files by repeated crashes must not turn every poll into
 * unbounded filesystem work. Real installations hold a handful of entries.
 */
const MAX_REGISTRY_FILES = 256;

/**
 * Whether `pid` is still the process the registry recorded.
 *
 * A registry file outlives a crash, so its mere presence proves nothing. The
 * signal-0 probe answers "does this pid exist" (EPERM means it exists but is
 * owned by someone else, which still counts), and on Linux the recorded
 * `procStart` is compared against the kernel's start-time for that pid so a
 * reused pid cannot be mistaken for the original process.
 */
async function isRecordedProcessAlive(pid: number, procStart: unknown): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EPERM') {
      return false;
    }
  }

  if (process.platform !== 'linux' || typeof procStart !== 'string' || !procStart) {
    return true;
  }

  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    // The comm field is parenthesised and may itself contain spaces, so the
    // fields are counted from the last ')'. starttime is the 22nd field
    // overall, i.e. the 20th of what follows the comm field.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] === procStart;
  } catch {
    // No procfs entry means the process is gone between the two checks.
    return false;
  }
}

/** Reads one registry file, returning null for anything that is not a live busy session. */
async function readLiveBusySession(filePath: string): Promise<LiveClaudeCliSession | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    // Unreadable, half-written or malformed entries are simply not evidence
    // of a running session.
    return null;
  }

  const record = parsed as Record<string, unknown> | null;
  if (!record || typeof record !== 'object') {
    return null;
  }

  const providerSessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
  const pid = typeof record.pid === 'number' ? record.pid : NaN;
  if (!providerSessionId || !Number.isInteger(pid) || pid <= 0 || record.status !== 'busy') {
    return null;
  }

  if (!(await isRecordedProcessAlive(pid, record.procStart))) {
    return null;
  }

  const startedAt = typeof record.startedAt === 'number' ? record.startedAt : Date.now();
  return { providerSessionId, startedAt };
}

/**
 * Lists the Claude CLI sessions that are mid-turn right now.
 *
 * Used by the providers module's sessions service so the running-sessions poll
 * also reports turns driven outside CloudCLI's own chat runs — including the
 * `claude` processes CloudCLI itself spawns for the Shell view, which live in
 * the PTY map rather than the chat-run registry. Liveness is ephemeral, so it
 * is recomputed on every read instead of being cached or persisted.
 */
export async function listBusyClaudeCliSessions(isolated: IsolatedLiveSource = runtimeLiveSource): Promise<LiveClaudeCliSession[]> {
  const fromRuntime = listBusyIsolatedSessions(isolated);
  let entries: string[];
  try {
    entries = await fsp.readdir(registryDirectory());
  } catch {
    // No registry directory at all is the normal case for an install that has
    // never run the CLI, and an unreadable one is not worth failing a poll for.
    return fromRuntime;
  }

  const registryFiles = entries.filter((entry) => entry.endsWith('.json')).slice(0, MAX_REGISTRY_FILES);
  const sessions = await Promise.all(
    registryFiles.map((entry) => readLiveBusySession(path.join(registryDirectory(), entry))),
  );

  return [...sessions.filter((session): session is LiveClaudeCliSession => session !== null), ...fromRuntime];
}

/** What the runtime knows about its live processes (injectable for tests). */
export type IsolatedLiveSource = {
  liveSessionIds: () => string[];
  isMidTurn: (sessionId: string) => boolean;
  session: (sessionId: string) => { provider_session_id?: string | null; project_path?: string | null } | null | undefined;
  startedAt?: (sessionId: string) => number | null;
};

const runtimeLiveSource: IsolatedLiveSource = {
  liveSessionIds: () => getActiveClaudeSDKSessions(),
  isMidTurn: (sessionId) => isClaudeSDKSessionMidTurn(sessionId),
  session: (sessionId) => sessionsDb.getSessionById(sessionId),
  startedAt: (sessionId) => getClaudeSDKSessionStartTime(sessionId),
};

/**
 * Isolated projects' CLI processes run in the sandbox: their registry files are in the sandbox home and their
 * pids in another pid namespace, so neither is read here. The runtime owns every such process and says itself
 * when one answers on its own (a follow-up turn after a background task settled).
 */
function listBusyIsolatedSessions(source: IsolatedLiveSource): LiveClaudeCliSession[] {
  const busy: LiveClaudeCliSession[] = [];
  for (const sessionId of source.liveSessionIds()) {
    if (!source.isMidTurn(sessionId)) continue;
    const row = source.session(sessionId);
    if (!row?.provider_session_id || !row.project_path || !isIsolatedPath(row.project_path)) continue;
    busy.push({ providerSessionId: row.provider_session_id, startedAt: source.startedAt?.(sessionId) ?? Date.now() });
  }
  return busy;
}

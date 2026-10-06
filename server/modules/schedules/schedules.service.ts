import fs from 'node:fs';
import path from 'node:path';

import { scheduleRunsDb, schedulesDb } from '@/modules/database/index.js';
import type { ScheduleKind, ScheduleRow, ScheduleRunRow, ScheduleRunStatus, ScheduleWrite } from '@/modules/database/index.js';
import { describeSchedule, isValidTimezone, nextRuns, parseScheduleSpec } from '@/modules/schedules/schedule-spec.js';
import type { ScheduleSpec } from '@/modules/schedules/schedule-spec.js';
import { recomputeNextRun, startRun } from '@/modules/schedules/scheduler.service.js';
import { broadcastSchedulesUpdated } from '@/modules/schedules/schedules-broadcast.js';
import { AppError } from '@/shared/utils.js';

const DEFAULT_TIMEZONE = 'Europe/Prague';
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
const RUN_STATUSES = new Set<ScheduleRunStatus>(['running', 'succeeded', 'failed', 'timeout', 'skipped', 'missed']);
const LOG_READ_LIMIT = 1024 * 1024;

/** What an agent attached to a schedule it proposed through MCP. */
export type ScheduleProposal = { note: string; projectPath: string | null; createdAt: string };

/** The API shape of a schedule (REST, MCP, client). */
export type PublicSchedule = {
  id: string;
  name: string;
  projectPath: string;
  kind: ScheduleKind;
  enabled: boolean;
  proposal: ScheduleProposal | null;
  schedule: ScheduleSpec | null;
  timezone: string;
  summary: string;
  prompt: string;
  provider: string;
  model: string | null;
  effort: string | null;
  permissionMode: string;
  sessionMode: 'new' | 'continue';
  sessionId: string | null;
  command: string;
  timeoutSec: number;
  handoff: 'none' | 'on_output';
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The API shape of one run. */
export type PublicRun = {
  id: string;
  scheduleId: string;
  scheduleName: string | null;
  kind: ScheduleKind | null;
  projectPath: string | null;
  trigger: 'schedule' | 'manual';
  scheduledFor: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  status: ScheduleRunStatus;
  sessionId: string | null;
  exitCode: number | null;
  output: string | null;
  hasLog: boolean;
  error: string | null;
};

/** Everything the form (or an agent) may send; missing fields keep their current or default value. */
export type ScheduleInput = {
  name?: unknown;
  projectPath?: unknown;
  kind?: unknown;
  schedule?: unknown;
  timezone?: unknown;
  prompt?: unknown;
  provider?: unknown;
  model?: unknown;
  effort?: unknown;
  permissionMode?: unknown;
  sessionMode?: unknown;
  command?: unknown;
  timeoutSec?: unknown;
  handoff?: unknown;
  enabled?: unknown;
};

function invalid(message: string): never {
  throw new AppError(message, { code: 'SCHEDULE_INVALID', statusCode: 400 });
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function requireSchedule(id: string): ScheduleRow {
  const row = schedulesDb.get(id);
  if (!row) throw new AppError('Schedule not found.', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
  return row;
}

function readSpec(row: ScheduleRow): ScheduleSpec | null {
  try {
    return parseScheduleSpec(JSON.parse(row.schedule));
  } catch {
    return null;
  }
}

/** Used by the MCP routes and the REST routes to shape a schedule row. */
export function toPublicSchedule(row: ScheduleRow): PublicSchedule {
  const spec = readSpec(row);
  return {
    id: row.id,
    name: row.name,
    projectPath: row.project_path,
    kind: row.kind,
    enabled: row.enabled === 1,
    proposal: parseJson<ScheduleProposal | null>(row.proposal, null),
    schedule: spec,
    timezone: row.timezone,
    summary: spec ? describeSchedule(spec, row.timezone) : 'Invalid schedule',
    prompt: row.prompt,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    permissionMode: row.permission_mode,
    sessionMode: row.session_mode,
    sessionId: row.session_id,
    command: row.command,
    timeoutSec: row.timeout_sec,
    handoff: row.handoff,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublicRun(row: ScheduleRunRow, schedules: Map<string, ScheduleRow>): PublicRun {
  const schedule = schedules.get(row.schedule_id);
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    scheduleName: schedule?.name ?? null,
    kind: schedule?.kind ?? null,
    projectPath: schedule?.project_path ?? null,
    trigger: row.trigger,
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    sessionId: row.session_id,
    exitCode: row.exit_code,
    output: row.output,
    hasLog: Boolean(row.log_path),
    error: row.error,
  };
}

function scheduleMap(): Map<string, ScheduleRow> {
  return new Map(schedulesDb.list().map((row) => [row.id, row]));
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Merges `input` over `current` (or defaults) and validates the result as a whole. */
function buildWrite(input: ScheduleInput, current: ScheduleRow | null, ownerUserId: number | null): Omit<ScheduleWrite, 'next_run_at' | 'proposal'> {
  const pick = <T>(value: unknown, fallback: T): T | unknown => (value === undefined ? fallback : value);

  const name = String(pick(input.name, current?.name ?? '')).trim();
  if (!name) invalid('A schedule needs a name.');
  if (name.length > 120) invalid('The name is too long (max 120 characters).');

  const projectPath = String(pick(input.projectPath, current?.project_path ?? '')).trim();
  if (!path.isAbsolute(projectPath)) invalid('The project must be an absolute path.');

  const kind = pick(input.kind, current?.kind ?? 'prompt');
  if (kind !== 'prompt' && kind !== 'script') invalid('Kind must be "prompt" or "script".');

  const spec = parseScheduleSpec(pick(input.schedule, current ? JSON.parse(current.schedule) : undefined));
  const timezone = String(pick(input.timezone, current?.timezone ?? DEFAULT_TIMEZONE)).trim() || DEFAULT_TIMEZONE;
  if (!isValidTimezone(timezone)) invalid(`Unknown time zone "${timezone}".`);

  const prompt = String(pick(input.prompt, current?.prompt ?? ''));
  const command = String(pick(input.command, current?.command ?? '')).trim();
  if (kind === 'prompt' && !prompt.trim()) invalid('An AI schedule needs a prompt.');
  if (kind === 'script' && !command) invalid('A script schedule needs a command.');

  const provider = String(pick(input.provider, current?.provider ?? 'claude')).trim() || 'claude';
  const permissionMode = String(pick(input.permissionMode, current?.permission_mode ?? 'bypassPermissions'));
  if (!PERMISSION_MODES.has(permissionMode)) invalid('Unknown permission mode.');
  const sessionMode = pick(input.sessionMode, current?.session_mode ?? 'new');
  if (sessionMode !== 'new' && sessionMode !== 'continue') invalid('Session mode must be "new" or "continue".');
  const handoff = pick(input.handoff, current?.handoff ?? 'none');
  if (handoff !== 'none' && handoff !== 'on_output') invalid('Hand-off must be "none" or "on_output".');
  const timeoutSec = Number(pick(input.timeoutSec, current?.timeout_sec ?? 1800));
  if (!Number.isInteger(timeoutSec) || timeoutSec < 10 || timeoutSec > 86_400) invalid('The timeout must be 10–86400 seconds.');

  return {
    name,
    project_path: path.resolve(projectPath),
    kind,
    enabled: input.enabled === undefined ? (current ? current.enabled === 1 : true) : input.enabled === true,
    schedule: JSON.stringify(spec),
    timezone,
    prompt,
    provider,
    model: input.model === undefined ? current?.model ?? null : optionalString(input.model),
    effort: input.effort === undefined ? current?.effort ?? null : optionalString(input.effort),
    permission_mode: permissionMode,
    session_mode: sessionMode,
    command,
    timeout_sec: timeoutSec,
    handoff,
    owner_user_id: current ? current.owner_user_id : ownerUserId,
  };
}

/** Plans the next run of an approved, enabled schedule; anything else has none. */
function planNextRun(id: string): ScheduleRow {
  const row = requireSchedule(id);
  const next = row.enabled === 1 && !row.proposal ? recomputeNextRun(row) : null;
  schedulesDb.setNextRun(id, next);
  return requireSchedule(id);
}

function removeLogs(paths: string[]): void {
  for (const logPath of paths) fs.rmSync(logPath, { force: true });
}

/** Used by the REST routes, MCP routes and plugin import. */
export const schedulesService = {
  list(projectPath?: string): PublicSchedule[] {
    return schedulesDb.list({ projectPath }).map(toPublicSchedule);
  },

  get(id: string): PublicSchedule {
    return toPublicSchedule(requireSchedule(id));
  },

  create(input: ScheduleInput, ownerUserId: number | null, proposal: ScheduleProposal | null = null): PublicSchedule {
    const write = buildWrite(input, null, ownerUserId);
    const row = schedulesDb.create({ ...write, proposal, next_run_at: null });
    const planned = planNextRun(row.id);
    broadcastSchedulesUpdated({ scheduleId: row.id });
    return toPublicSchedule(planned);
  },

  update(id: string, input: ScheduleInput): PublicSchedule {
    const current = requireSchedule(id);
    const write = buildWrite(input, current, current.owner_user_id);
    schedulesDb.update(id, write);
    // Switching away from "continue" drops the remembered chat.
    if (write.session_mode !== 'continue' && current.session_id) schedulesDb.setSessionId(id, null);
    const planned = planNextRun(id);
    broadcastSchedulesUpdated({ scheduleId: id });
    return toPublicSchedule(planned);
  },

  remove(id: string): void {
    requireSchedule(id);
    removeLogs(scheduleRunsDb.deleteForSchedule(id));
    schedulesDb.delete(id);
    broadcastSchedulesUpdated({ scheduleId: id });
  },

  /** A copy starts paused, so nothing runs twice by accident. */
  duplicate(id: string): PublicSchedule {
    const source = requireSchedule(id);
    const row = schedulesDb.create({
      ...buildWrite({}, source, source.owner_user_id),
      name: `${source.name} (copy)`.slice(0, 120),
      enabled: false,
      proposal: null,
      next_run_at: null,
    });
    broadcastSchedulesUpdated({ scheduleId: row.id });
    return toPublicSchedule(row);
  },

  approve(id: string): PublicSchedule {
    const row = requireSchedule(id);
    if (!row.proposal) throw new AppError('This schedule is not a pending proposal.', { code: 'SCHEDULE_NOT_PROPOSAL', statusCode: 409 });
    schedulesDb.approve(id);
    const planned = planNextRun(id);
    broadcastSchedulesUpdated({ scheduleId: id });
    return toPublicSchedule(planned);
  },

  runNow(id: string): PublicRun {
    const row = requireSchedule(id);
    if (row.proposal) throw new AppError('Approve the proposal before running it.', { code: 'SCHEDULE_NOT_APPROVED', statusCode: 409 });
    return toPublicRun(startRun(row, 'manual', null), scheduleMap());
  },

  listRuns(filter: { scheduleId?: string; projectPath?: string; status?: string; limit?: number } = {}): PublicRun[] {
    const status = filter.status && RUN_STATUSES.has(filter.status as ScheduleRunStatus) ? filter.status as ScheduleRunStatus : undefined;
    const map = scheduleMap();
    return scheduleRunsDb.list({ scheduleId: filter.scheduleId, projectPath: filter.projectPath, status, limit: filter.limit }).map((row) => toPublicRun(row, map));
  },

  /** One run; with `withLog` the full script log (up to 1 MiB) instead of just the stored tail. */
  getRun(id: string, withLog = false): PublicRun & { log?: string } {
    const row = scheduleRunsDb.get(id);
    if (!row) throw new AppError('Run not found.', { code: 'SCHEDULE_RUN_NOT_FOUND', statusCode: 404 });
    const run = toPublicRun(row, scheduleMap());
    if (!withLog || !row.log_path || !fs.existsSync(row.log_path)) return run;
    const handle = fs.openSync(row.log_path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(fs.fstatSync(handle).size, LOG_READ_LIMIT));
      fs.readSync(handle, buffer, 0, buffer.length, 0);
      const log = buffer.toString('utf8');
      // The log file stops at 1 MiB; the end of the output (where errors are) lives in the run row.
      const truncated = log.includes('[log truncated at 1 MiB');
      return { ...run, log: truncated && row.output ? `${log}\n[… end of the output, last 64 KiB …]\n${row.output}` : log };
    } finally {
      fs.closeSync(handle);
    }
  },

  preview(schedule: unknown, timezone?: unknown): { summary: string; nextRuns: string[] } {
    const spec = parseScheduleSpec(schedule);
    const zone = typeof timezone === 'string' && timezone.trim() ? timezone.trim() : DEFAULT_TIMEZONE;
    if (!isValidTimezone(zone)) invalid(`Unknown time zone "${zone}".`);
    return { summary: describeSchedule(spec, zone), nextRuns: nextRuns(spec, zone, 3).map((date) => date.toISOString()) };
  },

  countProposals(): number {
    return schedulesDb.countProposals();
  },
};

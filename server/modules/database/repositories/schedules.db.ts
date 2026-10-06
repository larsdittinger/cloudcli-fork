import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

/** What a schedule runs: an AI prompt as a chat, or a shell command in the project. */
export type ScheduleKind = 'prompt' | 'script';

/** Lifecycle of one schedule run; `missed` and `skipped` never started anything. */
export type ScheduleRunStatus = 'running' | 'succeeded' | 'failed' | 'timeout' | 'skipped' | 'missed';

/** One row of `schedules`, as stored. `schedule` and `proposal` are JSON. */
export type ScheduleRow = {
  id: string;
  name: string;
  project_path: string;
  kind: ScheduleKind;
  enabled: number;
  proposal: string | null;
  schedule: string;
  timezone: string;
  prompt: string;
  provider: string;
  model: string | null;
  effort: string | null;
  permission_mode: string;
  session_mode: 'new' | 'continue';
  session_id: string | null;
  command: string;
  timeout_sec: number;
  handoff: 'none' | 'on_output';
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  owner_user_id: number | null;
  created_at: string;
  updated_at: string;
};

/** One row of `schedule_runs`, newest first in every listing. */
export type ScheduleRunRow = {
  id: string;
  schedule_id: string;
  trigger: 'schedule' | 'manual';
  scheduled_for: string | null;
  started_at: string | null;
  finished_at: string | null;
  status: ScheduleRunStatus;
  session_id: string | null;
  exit_code: number | null;
  output: string | null;
  log_path: string | null;
  error: string | null;
  created_at: string;
};

/**
 * The editable part of a schedule. `proposal` set means an agent proposed it:
 * it is stored disabled regardless of `enabled` until an admin approves it.
 */
export type ScheduleWrite = Omit<
  ScheduleRow,
  'id' | 'created_at' | 'updated_at' | 'last_run_at' | 'last_status' | 'next_run_at' | 'session_id' | 'enabled' | 'proposal'
> & { enabled: boolean; proposal: Record<string, unknown> | null; next_run_at: string | null };

const SCHEDULE_COLUMNS = [
  'id', 'name', 'project_path', 'kind', 'enabled', 'proposal', 'schedule', 'timezone', 'prompt', 'provider', 'model', 'effort',
  'permission_mode', 'session_mode', 'session_id', 'command', 'timeout_sec', 'handoff', 'next_run_at', 'last_run_at', 'last_status',
  'owner_user_id', 'created_at', 'updated_at',
].join(', ');

const RUN_COLUMNS = 'id, schedule_id, trigger, scheduled_for, started_at, finished_at, status, session_id, exit_code, output, log_path, error, created_at';

/** Editable columns in insert order; `enabled` and `proposal` are converted separately. */
const WRITE_FIELDS = [
  'name', 'project_path', 'kind', 'schedule', 'timezone', 'prompt', 'provider', 'model', 'effort', 'permission_mode', 'session_mode',
  'command', 'timeout_sec', 'handoff', 'next_run_at', 'owner_user_id',
] as const;

export const schedulesDb = {
  create(input: ScheduleWrite): ScheduleRow {
    const id = randomUUID();
    const enabled = input.proposal ? 0 : (input.enabled ? 1 : 0);
    getConnection()
      .prepare(
        `INSERT INTO schedules (id, enabled, proposal, ${WRITE_FIELDS.join(', ')})
         VALUES (?, ?, ?, ${WRITE_FIELDS.map(() => '?').join(', ')})`,
      )
      .run(id, enabled, input.proposal ? JSON.stringify(input.proposal) : null, ...WRITE_FIELDS.map((field) => input[field] ?? null));
    return this.get(id) as ScheduleRow;
  },

  /** Rewrites the editable fields; a pending proposal stays disabled until approved. */
  update(id: string, patch: Partial<Omit<ScheduleWrite, 'proposal'>>): ScheduleRow | null {
    const current = this.get(id);
    if (!current) return null;
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const field of WRITE_FIELDS) {
      if (patch[field] !== undefined) {
        assignments.push(`${field} = ?`);
        values.push(patch[field]);
      }
    }
    if (patch.enabled !== undefined && !current.proposal) {
      assignments.push('enabled = ?');
      values.push(patch.enabled ? 1 : 0);
    }
    if (assignments.length > 0) {
      getConnection()
        .prepare(`UPDATE schedules SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(...values, id);
    }
    return this.get(id);
  },

  get(id: string): ScheduleRow | null {
    return (getConnection().prepare(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE id = ?`).get(id) as ScheduleRow | undefined) ?? null;
  },

  list(filter: { projectPath?: string } = {}): ScheduleRow[] {
    if (filter.projectPath) {
      return getConnection()
        .prepare(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE project_path = ? ORDER BY created_at ASC, rowid ASC`)
        .all(filter.projectPath) as ScheduleRow[];
    }
    return getConnection().prepare(`SELECT ${SCHEDULE_COLUMNS} FROM schedules ORDER BY project_path ASC, created_at ASC, rowid ASC`).all() as ScheduleRow[];
  },

  delete(id: string): boolean {
    return getConnection().prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0;
  },

  /** Approved, enabled schedules whose next run is due. */
  listDue(nowIso: string): ScheduleRow[] {
    return getConnection()
      .prepare(
        `SELECT ${SCHEDULE_COLUMNS} FROM schedules
         WHERE enabled = 1 AND proposal IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC`,
      )
      .all(nowIso) as ScheduleRow[];
  },

  setNextRun(id: string, nextIso: string | null, options: { disable?: boolean } = {}): void {
    getConnection()
      .prepare(`UPDATE schedules SET next_run_at = ?${options.disable ? ', enabled = 0' : ''} WHERE id = ?`)
      .run(nextIso, id);
  },

  /** Only the last-run columns: a run finishing must not overwrite an edit made while it ran. */
  recordResult(id: string, status: string, atIso: string): void {
    getConnection().prepare('UPDATE schedules SET last_status = ?, last_run_at = ? WHERE id = ?').run(status, atIso, id);
  },

  setSessionId(id: string, sessionId: string | null): void {
    getConnection().prepare('UPDATE schedules SET session_id = ? WHERE id = ?').run(sessionId, id);
  },

  approve(id: string): ScheduleRow | null {
    getConnection()
      .prepare('UPDATE schedules SET proposal = NULL, enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(id);
    return this.get(id);
  },

  countProposals(): number {
    return (getConnection().prepare('SELECT COUNT(*) AS count FROM schedules WHERE proposal IS NOT NULL').get() as { count: number }).count;
  },
};

export const scheduleRunsDb = {
  create(input: {
    scheduleId: string;
    trigger: 'schedule' | 'manual';
    scheduledFor: string | null;
    status: ScheduleRunStatus;
    startedAt?: string | null;
    finishedAt?: string | null;
    error?: string | null;
  }): ScheduleRunRow {
    const id = randomUUID();
    getConnection()
      .prepare(
        `INSERT INTO schedule_runs (id, schedule_id, trigger, scheduled_for, started_at, finished_at, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      // ISO created_at (not CURRENT_TIMESTAMP) so it compares correctly with the ISO prune cutoff.
      .run(
        id, input.scheduleId, input.trigger, input.scheduledFor, input.startedAt ?? null, input.finishedAt ?? null, input.status,
        input.error ?? null, new Date().toISOString(),
      );
    return this.get(id) as ScheduleRunRow;
  },

  finish(id: string, patch: {
    status: ScheduleRunStatus;
    finishedAt: string;
    exitCode?: number | null;
    output?: string | null;
    logPath?: string | null;
    error?: string | null;
    sessionId?: string | null;
  }): void {
    getConnection()
      .prepare(
        `UPDATE schedule_runs SET status = ?, finished_at = ?,
           exit_code = COALESCE(?, exit_code), output = COALESCE(?, output), log_path = COALESCE(?, log_path),
           error = COALESCE(?, error), session_id = COALESCE(?, session_id)
         WHERE id = ?`,
      )
      .run(
        patch.status, patch.finishedAt, patch.exitCode ?? null, patch.output ?? null, patch.logPath ?? null,
        patch.error ?? null, patch.sessionId ?? null, id,
      );
  },

  /** Links the chat as soon as it exists, so a running AI run can already be opened. */
  setSession(id: string, sessionId: string): void {
    getConnection().prepare('UPDATE schedule_runs SET session_id = ? WHERE id = ?').run(sessionId, id);
  },

  get(id: string): ScheduleRunRow | null {
    return (getConnection().prepare(`SELECT ${RUN_COLUMNS} FROM schedule_runs WHERE id = ?`).get(id) as ScheduleRunRow | undefined) ?? null;
  },

  list(filter: { scheduleId?: string; projectPath?: string; status?: ScheduleRunStatus; limit?: number } = {}): ScheduleRunRow[] {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.scheduleId) {
      where.push('r.schedule_id = ?');
      values.push(filter.scheduleId);
    }
    if (filter.projectPath) {
      where.push('s.project_path = ?');
      values.push(filter.projectPath);
    }
    if (filter.status) {
      where.push('r.status = ?');
      values.push(filter.status);
    }
    const limit = Math.min(Math.max(Math.floor(filter.limit ?? 100), 1), 500);
    return getConnection()
      .prepare(
        `SELECT ${RUN_COLUMNS.split(', ').map((column) => `r.${column}`).join(', ')}
         FROM schedule_runs r LEFT JOIN schedules s ON s.id = r.schedule_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?`,
      )
      .all(...values, limit) as ScheduleRunRow[];
  },

  isRunning(scheduleId: string): boolean {
    return Boolean(getConnection().prepare("SELECT 1 FROM schedule_runs WHERE schedule_id = ? AND status = 'running' LIMIT 1").get(scheduleId));
  },

  /** A run cannot outlive the server process that started it. */
  failRunningAfterRestart(): number {
    return getConnection()
      .prepare(
        `UPDATE schedule_runs SET status = 'failed', finished_at = ?, error = COALESCE(error, 'The server restarted while this run was in progress.')
         WHERE status = 'running'`,
      )
      .run(new Date().toISOString()).changes;
  },

  /** Deletes runs older than `cutoffIso` and beyond the newest `keepPerSchedule` per schedule; returns their log paths. */
  prune(cutoffIso: string, keepPerSchedule: number): string[] {
    const db = getConnection();
    const doomed = db
      .prepare(
        `SELECT id, log_path FROM (
           SELECT id, log_path, created_at,
             ROW_NUMBER() OVER (PARTITION BY schedule_id ORDER BY created_at DESC, rowid DESC) AS position
           FROM schedule_runs
         ) WHERE position > ? OR created_at < ?`,
      )
      .all(keepPerSchedule, cutoffIso) as Array<{ id: string; log_path: string | null }>;
    const remove = db.prepare('DELETE FROM schedule_runs WHERE id = ?');
    db.transaction(() => doomed.forEach((row) => remove.run(row.id)))();
    return doomed.map((row) => row.log_path).filter((value): value is string => Boolean(value));
  },

  deleteForSchedule(scheduleId: string): string[] {
    const db = getConnection();
    const logs = (db.prepare('SELECT log_path FROM schedule_runs WHERE schedule_id = ? AND log_path IS NOT NULL').all(scheduleId) as Array<{ log_path: string }>)
      .map((row) => row.log_path);
    db.prepare('DELETE FROM schedule_runs WHERE schedule_id = ?').run(scheduleId);
    return logs;
  },
};

import path from 'node:path';

import { getConnection } from '@/modules/database/connection.js';

/** Where a task stands; `done` and `cancelled` are closed and never wake. */
export type TaskStatus = 'new' | 'working' | 'waiting_external' | 'waiting_owner' | 'done' | 'cancelled';

/** One row of `tasks`, as stored. `checklist`, `question` and `pending_wake` are JSON. */
export type TaskRow = {
  id: number;
  title: string;
  brief: string;
  mandate: string;
  mandate_confirmed: number;
  summary: string;
  checklist: string;
  status: TaskStatus;
  question: string | null;
  next_check_at: string | null;
  pending_wake: string;
  running_session_id: string | null;
  running_since: string | null;
  seen_event_id: number;
  failure_count: number;
  project_path: string;
  provider: string;
  model: string | null;
  effort: string | null;
  permission_mode: string;
  owner_user_id: number | null;
  created_by: 'owner' | 'agent';
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /** `taskAttentionKey` of what needed the owner when they marked the task read; null = never read. */
  attention_read_key: string | null;
};

/**
 * Fingerprint of what an open task needs from the owner right now: the open
 * question (by when it was asked), an unconfirmed mandate and the waiting
 * drafts. Null when nothing does. Marking a task read stores it; a new
 * question or draft changes it, so the task counts again.
 */
export function taskAttentionKey(row: Pick<TaskRow, 'question' | 'mandate_confirmed'>, draftIds: string[]): string | null {
  // Any stored question counts, even one without a usable `askedAt`; its text then tells questions apart.
  let question: string | null = null;
  if (row.question !== null) {
    try {
      const parsed = JSON.parse(row.question) as { askedAt?: unknown; text?: unknown };
      question = `${typeof parsed.askedAt === 'string' ? parsed.askedAt : ''}|${typeof parsed.text === 'string' ? parsed.text : row.question}`;
    } catch {
      question = row.question;
    }
  }
  const mandate = row.mandate_confirmed === 0;
  if (question === null && !mandate && !draftIds.length) return null;
  return JSON.stringify({ q: question, m: mandate, d: [...draftIds].sort() });
}

/** What a new task is created from. */
export type TaskWrite = Pick<
  TaskRow,
  'title' | 'brief' | 'mandate' | 'mandate_confirmed' | 'status' | 'project_path' | 'provider' | 'model' | 'effort'
  | 'permission_mode' | 'owner_user_id' | 'created_by' | 'next_check_at' | 'question'
>;

/** Columns a service may change after creation. */
export type TaskPatch = Partial<Pick<
  TaskRow,
  'title' | 'brief' | 'mandate' | 'mandate_confirmed' | 'summary' | 'checklist' | 'status' | 'question' | 'next_check_at'
  | 'seen_event_id' | 'failure_count' | 'project_path' | 'provider' | 'model' | 'effort' | 'permission_mode' | 'closed_at'
>>;

/** Who wrote a diary entry. `external` = someone outside (a supplier's e-mail). */
export type TaskEventAuthor = 'owner' | 'agent' | 'system' | 'external';

/** One diary entry of a task. `meta` is JSON. */
export type TaskEventRow = {
  id: number;
  task_id: number;
  at: string;
  author: TaskEventAuthor;
  kind: string;
  text: string;
  meta: string | null;
  session_id: string | null;
};

const TASK_COLUMNS = [
  'id', 'title', 'brief', 'mandate', 'mandate_confirmed', 'summary', 'checklist', 'status', 'question', 'next_check_at',
  'pending_wake', 'running_session_id', 'running_since', 'seen_event_id', 'failure_count', 'project_path', 'provider', 'model',
  'effort', 'permission_mode', 'owner_user_id', 'created_by', 'created_at', 'updated_at', 'closed_at', 'attention_read_key',
].join(', ');

const PATCH_FIELDS = [
  'title', 'brief', 'mandate', 'mandate_confirmed', 'summary', 'checklist', 'status', 'question', 'next_check_at',
  'seen_event_id', 'failure_count', 'project_path', 'provider', 'model', 'effort', 'permission_mode', 'closed_at',
] as const;

const CLOSED: TaskStatus[] = ['done', 'cancelled'];

function nowIso(): string {
  return new Date().toISOString();
}

function readReasons(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

// tasksDb: used by the Tasks module for the cards, their wake-up queue and running state.
export const tasksDb = {
  create(input: TaskWrite): TaskRow {
    const at = nowIso();
    const result = getConnection()
      .prepare(
        `INSERT INTO tasks (title, brief, mandate, mandate_confirmed, status, project_path, provider, model, effort, permission_mode,
           owner_user_id, created_by, next_check_at, question, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.title, input.brief, input.mandate, input.mandate_confirmed, input.status, input.project_path, input.provider,
        input.model, input.effort, input.permission_mode, input.owner_user_id, input.created_by, input.next_check_at,
        input.question, at, at,
      );
    return this.get(Number(result.lastInsertRowid)) as TaskRow;
  },

  get(id: number): TaskRow | null {
    return (getConnection().prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined) ?? null;
  },

  /** Open tasks plus closed ones closed after `closedSince` (all closed ones when omitted), newest first. */
  list(filter: { projectPath?: string; closedSince?: string } = {}): TaskRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.projectPath) { clauses.push('project_path = ?'); params.push(filter.projectPath); }
    if (filter.closedSince) {
      clauses.push(`(status NOT IN ('done', 'cancelled') OR closed_at IS NULL OR closed_at >= ?)`);
      params.push(filter.closedSince);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return getConnection().prepare(`SELECT ${TASK_COLUMNS} FROM tasks ${where} ORDER BY updated_at DESC, id DESC`).all(...params) as TaskRow[];
  },

  update(id: number, patch: TaskPatch): TaskRow | null {
    const fields = PATCH_FIELDS.filter((field) => field in patch);
    if (fields.length) {
      const assignments = fields.map((field) => `${field} = ?`).join(', ');
      const values = fields.map((field) => patch[field] ?? null);
      getConnection().prepare(`UPDATE tasks SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
    }
    return this.get(id);
  },

  /** Stores what the owner has seen (see `taskAttentionKey`); not an edit, so `updated_at` stays. */
  setAttentionRead(id: number, key: string | null): void {
    getConnection().prepare('UPDATE tasks SET attention_read_key = ? WHERE id = ?').run(key, id);
  },

  delete(id: number): void {
    const db = getConnection();
    db.transaction(() => {
      db.prepare('DELETE FROM task_events WHERE task_id = ?').run(id);
      db.prepare('DELETE FROM task_threads WHERE task_id = ?').run(id);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    })();
  },

  setRunning(id: number, sessionId: string | null, since: string | null): void {
    getConnection().prepare('UPDATE tasks SET running_session_id = ?, running_since = ? WHERE id = ?').run(sessionId, since, id);
  },

  /** Queues a reason for the next run; the same reason twice counts once. */
  addPendingWake(id: number, reason: string): void {
    const db = getConnection();
    db.transaction(() => {
      const row = db.prepare('SELECT pending_wake FROM tasks WHERE id = ?').get(id) as { pending_wake: string } | undefined;
      if (!row) return;
      const reasons = readReasons(row.pending_wake);
      if (!reasons.includes(reason)) reasons.push(reason);
      db.prepare('UPDATE tasks SET pending_wake = ? WHERE id = ?').run(JSON.stringify(reasons), id);
    })();
  },

  /** Returns the queued reasons and clears them, atomically. */
  takePendingWake(id: number): string[] {
    const db = getConnection();
    return db.transaction(() => {
      const row = db.prepare('SELECT pending_wake FROM tasks WHERE id = ?').get(id) as { pending_wake: string } | undefined;
      if (!row) return [];
      db.prepare(`UPDATE tasks SET pending_wake = '[]' WHERE id = ?`).run(id);
      return readReasons(row.pending_wake);
    })();
  },

  /**
   * Idle open tasks that should run now: an explicit wake is queued, or the
   * agent's next check is due (not while the task waits for the owner).
   */
  listWakeable(now: string): TaskRow[] {
    return getConnection()
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks
         WHERE running_session_id IS NULL AND status NOT IN ('done', 'cancelled')
           AND (pending_wake <> '[]' OR (status <> 'waiting_owner' AND next_check_at IS NOT NULL AND next_check_at <= ?))
         ORDER BY COALESCE(next_check_at, created_at) ASC, id ASC`,
      )
      .all(now) as TaskRow[];
  },

  /** Open tasks with a run in progress in this project directory (used to scope agent sends). */
  listRunningIn(projectPath: string): TaskRow[] {
    // Compared resolved: a stored "/workspace/x/" and a cwd "/workspace/x" are the same project.
    const wanted = path.resolve(projectPath);
    return (getConnection()
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE running_session_id IS NOT NULL`)
      .all() as TaskRow[]).filter((row) => path.resolve(row.project_path) === wanted);
  },

  countRunning(): number {
    return (getConnection().prepare('SELECT COUNT(*) AS count FROM tasks WHERE running_session_id IS NOT NULL').get() as { count: number }).count;
  },

  /** Clears running state left by a stopped process and returns the tasks it interrupted. */
  resetRunningAfterRestart(): TaskRow[] {
    const db = getConnection();
    return db.transaction(() => {
      const rows = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE running_session_id IS NOT NULL`).all() as TaskRow[];
      db.prepare('UPDATE tasks SET running_session_id = NULL, running_since = NULL WHERE running_session_id IS NOT NULL').run();
      return rows;
    })();
  },

  /**
   * Open tasks that need the owner: a question, an unconfirmed mandate or an
   * outgoing draft, with the ids of those drafts and what the owner last
   * marked read. `attention` counts the ones whose need is new to the owner.
   */
  listNeedingOwner(filter: { ids?: number[]; projectPath?: string } = {}): Array<Pick<TaskRow, 'id' | 'project_path' | 'question' | 'mandate_confirmed' | 'attention_read_key'> & { draftIds: string[] }> {
    const clauses = [`t.status NOT IN (${CLOSED.map(() => '?').join(', ')})`];
    const params: unknown[] = [...CLOSED];
    if (filter.ids) {
      if (!filter.ids.length) return [];
      clauses.push(`t.id IN (${filter.ids.map(() => '?').join(', ')})`);
      params.push(...filter.ids);
    }
    if (filter.projectPath) {
      clauses.push('t.project_path = ?');
      params.push(filter.projectPath);
    }
    const rows = getConnection()
      .prepare(
        `SELECT t.id, t.project_path, t.question, t.mandate_confirmed, t.attention_read_key,
                (SELECT GROUP_CONCAT(o.id) FROM channel_outbox o WHERE o.task_id = t.id AND o.status IN ('draft', 'failed')) AS draft_ids
         FROM tasks t
         WHERE ${clauses.join(' AND ')}
           AND (t.question IS NOT NULL OR t.mandate_confirmed = 0
                OR EXISTS (SELECT 1 FROM channel_outbox o WHERE o.task_id = t.id AND o.status IN ('draft', 'failed')))`,
      )
      .all(...params) as Array<Pick<TaskRow, 'id' | 'project_path' | 'question' | 'mandate_confirmed' | 'attention_read_key'> & { draft_ids: string | null }>;
    return rows.map(({ draft_ids: draftIds, ...row }) => ({ ...row, draftIds: draftIds ? draftIds.split(',') : [] }));
  },

  /**
   * Open tasks that need the owner and whose need the owner has not marked
   * read yet. Each task counts once.
   */
  attention(): { total: number; byProject: Record<string, number> } {
    const rows = this.listNeedingOwner().filter((row) => taskAttentionKey(row, row.draftIds) !== row.attention_read_key);
    const byProject: Record<string, number> = {};
    for (const row of rows) byProject[row.project_path] = (byProject[row.project_path] ?? 0) + 1;
    return { total: rows.length, byProject };
  },
};

// taskEventsDb: used by the Tasks module for each task's append-only diary.
export const taskEventsDb = {
  add(input: { taskId: number; author: TaskEventAuthor; kind: string; text: string; meta?: Record<string, unknown> | null; sessionId?: string | null; at?: string }): TaskEventRow {
    const result = getConnection()
      .prepare('INSERT INTO task_events (task_id, at, author, kind, text, meta, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.taskId, input.at ?? nowIso(), input.author, input.kind, input.text, input.meta ? JSON.stringify(input.meta) : null, input.sessionId ?? null);
    return getConnection().prepare('SELECT * FROM task_events WHERE id = ?').get(Number(result.lastInsertRowid)) as TaskEventRow;
  },

  /** Oldest first. `limit` keeps the newest entries; `afterId` only those after it. */
  list(taskId: number, options: { afterId?: number; limit?: number } = {}): TaskEventRow[] {
    const limit = options.limit ? Math.max(1, Math.floor(options.limit)) : -1;
    const rows = getConnection()
      .prepare('SELECT * FROM task_events WHERE task_id = ? AND id > ? ORDER BY id DESC LIMIT ?')
      .all(taskId, options.afterId ?? 0, limit) as TaskEventRow[];
    return rows.reverse();
  },

  count(taskId: number): number {
    return (getConnection().prepare('SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?').get(taskId) as { count: number }).count;
  },

  countSince(taskId: number, kind: string, since: string): number {
    return (getConnection()
      .prepare('SELECT COUNT(*) AS count FROM task_events WHERE task_id = ? AND kind = ? AND at >= ?')
      .get(taskId, kind, since) as { count: number }).count;
  },

  /** When `author` last wrote to the task, or null. */
  lastAt(taskId: number, author: TaskEventAuthor): string | null {
    const row = getConnection().prepare('SELECT MAX(at) AS at FROM task_events WHERE task_id = ? AND author = ?').get(taskId, author) as { at: string | null };
    return row.at;
  },

  latestId(taskId: number): number {
    return (getConnection().prepare('SELECT COALESCE(MAX(id), 0) AS id FROM task_events WHERE task_id = ?').get(taskId) as { id: number }).id;
  },
};

// taskThreadsDb: used by the Tasks module to route replies in a task's conversations back to the task.
export const taskThreadsDb = {
  /**
   * A conversation belongs to the open task that started it; a closed task's
   * conversation can be taken over (a WhatsApp chat with a supplier spans tasks).
   */
  link(accountId: string, threadKey: string, taskId: number): void {
    getConnection()
      .prepare(
        `INSERT INTO task_threads (account_id, thread_key, task_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, thread_key) DO UPDATE SET task_id = excluded.task_id
         WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_threads.task_id AND t.status NOT IN ('done', 'cancelled'))`,
      )
      .run(accountId, threadKey, taskId, nowIso());
  },

  find(accountId: string, threadKey: string): number | null {
    const row = getConnection().prepare('SELECT task_id FROM task_threads WHERE account_id = ? AND thread_key = ?').get(accountId, threadKey) as { task_id: number } | undefined;
    return row?.task_id ?? null;
  },
};

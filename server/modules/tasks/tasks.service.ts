import path from 'node:path';

import { channelOutboxDb, taskEventsDb, tasksDb } from '@/modules/database/index.js';
import type { TaskEventAuthor, TaskEventRow, TaskPatch, TaskRow, TaskStatus } from '@/modules/database/index.js';
import { broadcastTasksUpdated } from '@/modules/tasks/tasks-broadcast.js';
import { abortTaskRun, queueWake } from '@/modules/tasks/wake-queue.js';
import { AppError } from '@/shared/utils.js';

const STATUSES: TaskStatus[] = ['new', 'working', 'waiting_external', 'waiting_owner', 'done', 'cancelled'];
const CLOSED: TaskStatus[] = ['done', 'cancelled'];
/** Statuses an agent may set itself; it reaches the owner only through a question. */
const AGENT_STATUSES: TaskStatus[] = ['working', 'waiting_external', 'done', 'cancelled'];
const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
const MAX_CHECK_DAYS = 90;
const CLOSED_VISIBLE_DAYS = 30;

/** One checklist item of a task's plan. */
export type TaskChecklistItem = { text: string; done: boolean };

/** A question that waits for the owner; `by: 'system'` when the engine itself needs a decision. */
export type TaskQuestion = { text: string; options: string[]; by: 'agent' | 'system'; askedAt: string };

/** A task as the API and the agents see it. */
export type PublicTask = {
  id: number;
  title: string;
  brief: string;
  mandate: string;
  mandateConfirmed: boolean;
  summary: string;
  checklist: TaskChecklistItem[];
  status: TaskStatus;
  question: TaskQuestion | null;
  nextCheckAt: string | null;
  running: { sessionId: string; since: string | null } | null;
  pendingWake: string[];
  failureCount: number;
  projectPath: string;
  provider: string;
  model: string | null;
  effort: string | null;
  permissionMode: string;
  ownerUserId: number | null;
  createdBy: 'owner' | 'agent';
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Outgoing messages of this task that wait for the owner (drafts and failed sends). */
  draftCount: number;
};

/** One diary entry as the API returns it. */
export type PublicTaskEvent = {
  id: number;
  at: string;
  author: TaskEventAuthor;
  kind: string;
  text: string;
  meta: Record<string, unknown> | null;
  sessionId: string | null;
};

/** An outgoing message of a task, for the detail view. */
export type PublicTaskMessage = {
  id: string;
  accountId: string;
  to: string;
  subject: string | null;
  text: string;
  status: string;
  statusDetail: string | null;
  createdAt: string;
  sentAt: string | null;
};

/** What the owner (UI) or an agent (MCP) sends to create a task. */
export type TaskInput = {
  title?: unknown;
  brief?: unknown;
  mandate?: unknown;
  projectPath?: unknown;
  provider?: unknown;
  model?: unknown;
  effort?: unknown;
  permissionMode?: unknown;
  nextCheckInMinutes?: unknown;
};

/** What an agent may change on its own card. */
export type AgentTaskUpdate = {
  summary?: unknown;
  checklist?: unknown;
  status?: unknown;
  nextCheckAt?: unknown;
  nextCheckInMinutes?: unknown;
};

function badRequest(message: string): AppError {
  return new AppError(message, { code: 'INVALID_TASK', statusCode: 400 });
}

function conflict(message: string): AppError {
  return new AppError(message, { code: 'TASK_CONFLICT', statusCode: 409 });
}

function parseJsonValue<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isClosed(status: TaskStatus): boolean {
  return CLOSED.includes(status);
}

function requireTask(id: number): TaskRow {
  const row = Number.isInteger(id) ? tasksDb.get(id) : null;
  if (!row) throw new AppError(`Task #${id} not found.`, { code: 'TASK_NOT_FOUND', statusCode: 404 });
  return row;
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${field} is required.`);
  const text = value.trim();
  if (text.length > max) throw badRequest(`${field} is too long (max ${max} characters).`);
  return text;
}

function optionalText(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw badRequest(`${field} must be text.`);
  const text = value.trim();
  if (text.length > max) throw badRequest(`${field} is too long (max ${max} characters).`);
  return text;
}

function optionalName(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 100) throw badRequest(`${field} is invalid.`);
  return value.trim() || null;
}

function readProjectPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw badRequest('The agent project is required.');
  const projectPath = value.trim();
  if (!path.isAbsolute(projectPath)) throw badRequest('The agent project must be an absolute path.');
  return path.normalize(projectPath);
}

function readPermissionMode(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'bypassPermissions';
  if (typeof value !== 'string' || !PERMISSION_MODES.includes(value)) throw badRequest(`Permission mode must be one of ${PERMISSION_MODES.join(', ')}.`);
  return value;
}

function readChecklist(value: unknown): TaskChecklistItem[] {
  if (!Array.isArray(value)) throw badRequest('checklist must be a list of { text, done }.');
  if (value.length > 50) throw badRequest('checklist has at most 50 items.');
  return value.map((item) => {
    const record = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    return { text: requiredText(record.text, 'Checklist item', 300), done: record.done === true };
  });
}

/** Turns `nextCheckAt` (ISO) or `nextCheckInMinutes` into a stored time; `null` clears it. */
function readNextCheck(at: unknown, inMinutes: unknown, now: Date): string | null | undefined {
  if (inMinutes !== undefined && inMinutes !== null) {
    const minutes = Number(inMinutes);
    if (!Number.isFinite(minutes) || minutes < 0) throw badRequest('nextCheckInMinutes must be a positive number.');
    if (minutes > MAX_CHECK_DAYS * 24 * 60) throw badRequest(`The next check can be at most ${MAX_CHECK_DAYS} days away.`);
    return new Date(now.getTime() + minutes * 60_000).toISOString();
  }
  if (at === undefined) return undefined;
  if (at === null || at === '') return null;
  const time = typeof at === 'string' ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(time)) throw badRequest('nextCheckAt must be an ISO date and time.');
  if (time > now.getTime() + MAX_CHECK_DAYS * 24 * 60 * 60_000) throw badRequest(`The next check can be at most ${MAX_CHECK_DAYS} days away.`);
  return new Date(Math.max(time, now.getTime())).toISOString();
}

function draftCount(taskId: number): number {
  return channelOutboxDb.listByTask(taskId).filter((row) => row.status === 'draft' || row.status === 'failed').length;
}

// toPublicTask: used by the service, the engine and the MCP bridge to shape a row for callers.
export function toPublicTask(row: TaskRow): PublicTask {
  return {
    id: row.id,
    title: row.title,
    brief: row.brief,
    mandate: row.mandate,
    mandateConfirmed: row.mandate_confirmed === 1,
    summary: row.summary,
    checklist: parseJsonValue<TaskChecklistItem[]>(row.checklist, []),
    status: row.status,
    question: parseJsonValue<TaskQuestion | null>(row.question, null),
    nextCheckAt: row.next_check_at,
    running: row.running_session_id ? { sessionId: row.running_session_id, since: row.running_since } : null,
    pendingWake: parseJsonValue<string[]>(row.pending_wake, []),
    failureCount: row.failure_count,
    projectPath: row.project_path,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    permissionMode: row.permission_mode,
    ownerUserId: row.owner_user_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    draftCount: draftCount(row.id),
  };
}

// toPublicEvent: used by the service and the MCP bridge to shape diary entries.
export function toPublicEvent(row: TaskEventRow): PublicTaskEvent {
  return {
    id: row.id,
    at: row.at,
    author: row.author,
    kind: row.kind,
    text: row.text,
    meta: parseJsonValue<Record<string, unknown> | null>(row.meta, null),
    sessionId: row.session_id,
  };
}

function logEvent(taskId: number, author: TaskEventAuthor, kind: string, text: string, meta?: Record<string, unknown>): void {
  taskEventsDb.add({ taskId, author, kind, text, meta: meta ?? null });
}

function changed(id: number): PublicTask {
  broadcastTasksUpdated({ taskId: id });
  return toPublicTask(requireTask(id));
}

/** Closing clears everything that could wake the task again. */
function closingPatch(status: TaskStatus): TaskPatch {
  return { status, closed_at: new Date().toISOString(), next_check_at: null, question: null };
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  new: 'New',
  working: 'Working',
  waiting_external: 'Waiting for a reply',
  waiting_owner: 'Waiting for you',
  done: 'Done',
  cancelled: 'Cancelled',
};

// tasksService: used by the Tasks routes (owner), the MCP bridge (agents), the engine and the channel link.
export const tasksService = {
  list(filter: { projectPath?: string; includeOldClosed?: boolean } = {}): PublicTask[] {
    const closedSince = filter.includeOldClosed ? undefined : new Date(Date.now() - CLOSED_VISIBLE_DAYS * 24 * 60 * 60_000).toISOString();
    return tasksDb.list({ projectPath: filter.projectPath, closedSince }).map(toPublicTask);
  },

  get(id: number, options: { eventLimit?: number } = {}): { task: PublicTask; events: PublicTaskEvent[]; eventCount: number; messages: PublicTaskMessage[] } {
    const row = requireTask(id);
    return {
      task: toPublicTask(row),
      events: taskEventsDb.list(id, { limit: options.eventLimit }).map(toPublicEvent),
      eventCount: taskEventsDb.count(id),
      messages: channelOutboxDb.listByTask(id).map((message) => ({
        id: message.id,
        accountId: message.account_id,
        to: message.to_address,
        subject: message.subject,
        text: message.text,
        status: message.status,
        statusDetail: message.status_detail,
        createdAt: message.created_at,
        sentAt: message.sent_at,
      })),
    };
  },

  create(input: TaskInput, origin: { by: 'owner'; userId?: number | null } | { by: 'agent'; cwd?: string | null; userId?: number | null }): PublicTask {
    const title = requiredText(input.title, 'Title', 200);
    const brief = requiredText(input.brief, 'Brief', 20_000);
    const mandate = optionalText(input.mandate, 'Mandate', 5_000);
    const projectPath = readProjectPath(input.projectPath ?? (origin.by === 'agent' ? origin.cwd : undefined));
    const nextCheck = readNextCheck(undefined, input.nextCheckInMinutes, new Date());
    const row = tasksDb.create({
      title,
      brief,
      mandate,
      // An agent writes the mandate from what it understood; the owner confirms it before anything leaves on its own.
      mandate_confirmed: origin.by === 'owner' ? 1 : 0,
      status: 'new',
      project_path: projectPath,
      provider: optionalName(input.provider, 'Provider') ?? 'claude',
      model: optionalName(input.model, 'Model'),
      effort: optionalName(input.effort, 'Effort'),
      permission_mode: readPermissionMode(input.permissionMode),
      owner_user_id: origin.userId ?? null,
      created_by: origin.by,
      next_check_at: nextCheck ?? null,
      question: null,
    });
    logEvent(row.id, origin.by, 'created', origin.by === 'owner' ? 'Task created.' : 'Task created by an agent; the mandate waits for your confirmation.');
    // A delayed start (agent-created with a check time) just waits for that time.
    if (!nextCheck) queueWake(row.id, 'created');
    return changed(row.id);
  },

  updateByOwner(id: number, input: TaskInput & { title?: unknown }): PublicTask {
    const row = requireTask(id);
    const patch: TaskPatch = {};
    if (input.title !== undefined) patch.title = requiredText(input.title, 'Title', 200);
    if (input.brief !== undefined) patch.brief = requiredText(input.brief, 'Brief', 20_000);
    if (input.mandate !== undefined) {
      patch.mandate = optionalText(input.mandate, 'Mandate', 5_000);
      patch.mandate_confirmed = 1;
    }
    if (input.projectPath !== undefined) patch.project_path = readProjectPath(input.projectPath);
    if (input.provider !== undefined) patch.provider = optionalName(input.provider, 'Provider') ?? 'claude';
    if (input.model !== undefined) patch.model = optionalName(input.model, 'Model');
    if (input.effort !== undefined) patch.effort = optionalName(input.effort, 'Effort');
    if (input.permissionMode !== undefined) patch.permission_mode = readPermissionMode(input.permissionMode);
    tasksDb.update(id, patch);

    const briefChanged = patch.brief !== undefined && patch.brief !== row.brief;
    const mandateChanged = patch.mandate !== undefined && (patch.mandate !== row.mandate || row.mandate_confirmed === 0);
    if (mandateChanged) logEvent(id, 'owner', 'mandate', `Mandate set: ${patch.mandate || '(none)'}`);
    if (briefChanged) logEvent(id, 'owner', 'edit', `Brief changed:\n${patch.brief}`);
    else if (patch.title !== undefined && patch.title !== row.title) logEvent(id, 'owner', 'edit', `Renamed to “${patch.title}”.`);
    if ((briefChanged || mandateChanged) && !isClosed(row.status)) queueWake(id, 'owner_edit');
    return changed(id);
  },

  confirmMandate(id: number): PublicTask {
    const row = requireTask(id);
    if (row.mandate_confirmed === 1) return toPublicTask(row);
    tasksDb.update(id, { mandate_confirmed: 1 });
    logEvent(id, 'owner', 'mandate', 'Mandate confirmed.');
    if (!isClosed(row.status)) queueWake(id, 'mandate_confirmed');
    return changed(id);
  },

  comment(id: number, text: unknown): PublicTask {
    const row = requireTask(id);
    logEvent(id, 'owner', 'comment', requiredText(text, 'Comment', 10_000));
    if (!isClosed(row.status)) queueWake(id, 'owner_comment');
    return changed(id);
  },

  answer(id: number, input: { option?: unknown; text?: unknown }): PublicTask {
    const row = requireTask(id);
    const question = parseJsonValue<TaskQuestion | null>(row.question, null);
    if (!question) throw conflict('There is no open question on this task.');
    const option = typeof input.option === 'string' && input.option.trim() ? input.option.trim() : '';
    const note = optionalText(input.text, 'Answer', 10_000);
    if (!option && !note) throw badRequest('Pick an option or write an answer.');

    // System questions are the engine asking whether to go on; "cancel" closes the task.
    if (question.by === 'system' && /^cancel/i.test(option)) {
      tasksDb.update(id, { ...closingPatch('cancelled'), failure_count: 0 });
      tasksDb.takePendingWake(id);
      logEvent(id, 'owner', 'answer', `${question.text}\n→ ${option}`);
      return changed(id);
    }
    tasksDb.update(id, { question: null, status: 'working', failure_count: 0 });
    logEvent(id, 'owner', 'answer', `${question.text}\n→ ${[option, note].filter(Boolean).join(' — ')}`, { option: option || null });
    queueWake(id, 'owner_answer');
    return changed(id);
  },

  /** The owner moves a task between columns; reopening a closed task wakes it. */
  setStatus(id: number, status: unknown): PublicTask {
    const row = requireTask(id);
    if (typeof status !== 'string' || !STATUSES.includes(status as TaskStatus)) throw badRequest('Unknown status.');
    const next = status as TaskStatus;
    if (next === row.status) return toPublicTask(row);
    if (isClosed(next)) {
      tasksDb.update(id, closingPatch(next));
      tasksDb.takePendingWake(id);
      if (row.running_session_id) abortTaskRun(id, row.running_session_id);
    } else {
      tasksDb.update(id, { status: next, closed_at: null, ...(next !== 'waiting_owner' ? { question: null } : {}) });
    }
    logEvent(id, 'owner', 'status', `Moved to ${STATUS_LABELS[next]}.`);
    if (isClosed(row.status) && !isClosed(next)) queueWake(id, 'reopened');
    return changed(id);
  },

  wakeNow(id: number): PublicTask {
    const row = requireTask(id);
    if (isClosed(row.status)) throw conflict('Reopen the task before waking it.');
    queueWake(id, 'owner_wake');
    return changed(id);
  },

  remove(id: number): void {
    const row = requireTask(id);
    for (const message of channelOutboxDb.listByTask(id)) {
      if (message.status === 'draft' || message.status === 'failed') channelOutboxDb.setStatus(message.id, 'discarded');
    }
    tasksDb.delete(id);
    if (row.running_session_id) abortTaskRun(id, row.running_session_id);
    broadcastTasksUpdated({ taskId: id });
  },

  // ---- Agent side (MCP) ----

  agentUpdate(id: number, input: AgentTaskUpdate): PublicTask {
    const row = requireTask(id);
    if (isClosed(row.status)) throw conflict(`Task #${id} is closed; only tasks_log still works.`);
    const patch: TaskPatch = {};
    if (input.summary !== undefined) patch.summary = optionalText(input.summary, 'summary', 20_000);
    if (input.checklist !== undefined) patch.checklist = JSON.stringify(readChecklist(input.checklist));
    const nextCheck = readNextCheck(input.nextCheckAt, input.nextCheckInMinutes, new Date());
    if (nextCheck !== undefined) patch.next_check_at = nextCheck;

    let status: TaskStatus | null = null;
    if (input.status !== undefined) {
      if (typeof input.status !== 'string' || !AGENT_STATUSES.includes(input.status as TaskStatus)) {
        throw badRequest(`status must be one of ${AGENT_STATUSES.join(', ')}; ask the owner with tasks_ask_owner instead of setting waiting_owner.`);
      }
      status = input.status as TaskStatus;
    }
    if (status && isClosed(status)) {
      Object.assign(patch, closingPatch(status));
      tasksDb.takePendingWake(id);
    } else if (status && status !== row.status) {
      // Going on without the owner withdraws an open question.
      Object.assign(patch, { status, question: null });
    }
    tasksDb.update(id, patch);
    if (status && status !== row.status) logEvent(id, 'agent', 'status', `Moved to ${STATUS_LABELS[status]}.`);
    return changed(id);
  },

  log(id: number, text: unknown): PublicTask {
    requireTask(id);
    logEvent(id, 'agent', 'note', requiredText(text, 'text', 10_000));
    return changed(id);
  },

  ask(id: number, input: { question?: unknown; options?: unknown }, by: 'agent' | 'system' = 'agent'): PublicTask {
    const row = requireTask(id);
    if (isClosed(row.status)) throw conflict(`Task #${id} is closed.`);
    const text = requiredText(input.question, 'question', 4_000);
    const options = input.options === undefined || input.options === null ? [] : input.options;
    if (!Array.isArray(options) || options.length > 6) throw badRequest('options is a list of at most 6 choices.');
    const cleaned = options.map((option) => requiredText(option, 'Option', 80));
    const question: TaskQuestion = { text, options: cleaned, by, askedAt: new Date().toISOString() };
    tasksDb.update(id, { question: JSON.stringify(question), status: 'waiting_owner', next_check_at: null });
    logEvent(id, by, 'question', cleaned.length ? `${text}\nOptions: ${cleaned.join(' / ')}` : text);
    return changed(id);
  },

  attention(): { total: number; byProject: Record<string, number> } {
    return tasksDb.attention();
  },
};

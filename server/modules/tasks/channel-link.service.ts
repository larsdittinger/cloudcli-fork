import { outboxService, setChannelTaskHooks } from '@/modules/channels/index.js';
import type { ChannelMessageRow, ChannelOutboxRow } from '@/modules/channels/index.js';
import { channelAccountsDb, channelMessagesDb, taskEventsDb, tasksDb, taskThreadsDb } from '@/modules/database/index.js';
import type { TaskRow } from '@/modules/database/index.js';
import { broadcastTasksUpdated } from '@/modules/tasks/tasks-broadcast.js';
import { queueWake } from '@/modules/tasks/wake-queue.js';
import { AppError } from '@/shared/utils.js';

/** Inbound text kept in the diary; the full message (and attachments) stays in Channels. */
const DIARY_TEXT_LIMIT = 4000;
const TAG_PATTERN = /\[#(\d{1,9})\]/;

function isOpen(task: TaskRow | null): task is TaskRow {
  return task !== null && task.status !== 'done' && task.status !== 'cancelled';
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n… (zkráceno, celé: channels_get_message)` : trimmed;
}

function tagFor(taskId: number): string {
  return `[#${taskId}]`;
}

/** Keeps the task tag in an e-mail subject so a reply outside the thread still finds the task. */
function taggedSubject(subject: string, taskId: number): string {
  return subject.includes(tagFor(taskId)) ? subject : `${subject} ${tagFor(taskId)}`.trim();
}

/** A reply in a task's thread, or a message tagged `[#N]` for an open task, belongs to that task. */
function routeInbound(message: ChannelMessageRow): number | null {
  const threadTask = taskThreadsDb.find(message.account_id, message.thread_key);
  const tagged = TAG_PATTERN.exec(message.subject ?? '');
  const candidates = [threadTask, tagged ? Number(tagged[1]) : null].filter((id): id is number => id !== null);
  const task = candidates.map((id) => tasksDb.get(id)).find(isOpen);
  if (!task) return null;

  taskThreadsDb.link(message.account_id, message.thread_key, task.id);
  const from = message.from_name ? `${message.from_name} <${message.from_address}>` : message.from_address;
  const attachments = (() => {
    try {
      return (JSON.parse(message.attachments_json || '[]') as unknown[]).length;
    } catch {
      return 0;
    }
  })();
  const header = [`Od: ${from}`, message.subject ? `Předmět: ${message.subject}` : null, attachments ? `Přílohy: ${attachments} (channels_get_message)` : null]
    .filter(Boolean)
    .join('\n');
  taskEventsDb.add({
    taskId: task.id,
    author: 'external',
    kind: 'message_in',
    text: `${header}\n\n${clip(message.text, DIARY_TEXT_LIMIT)}`,
    meta: { messageId: message.id, accountId: message.account_id, from: message.from_address, subject: message.subject, channel: message.channel },
  });
  queueWake(task.id, 'message');
  return task.id;
}

function onSent(row: ChannelOutboxRow, info: { threadKey: string | null; afterApproval: boolean }): void {
  if (row.task_id === null || !tasksDb.get(row.task_id)) return;
  if (info.threadKey) taskThreadsDb.link(row.account_id, info.threadKey, row.task_id);
  if (info.afterApproval) {
    taskEventsDb.add({
      taskId: row.task_id,
      author: 'owner',
      kind: 'message_out',
      text: `Draft approved and sent to ${row.to_address}${row.subject ? ` — ${row.subject}` : ''}.`,
      meta: { outboxId: row.id },
    });
    broadcastTasksUpdated({ taskId: row.task_id });
  }
}

/** Used by the tasks module at start: Channels hands task replies here and reports task sends. */
export function initializeChannelLink(): void {
  setChannelTaskHooks({ routeInbound, onSent });
}

/** Used by the tasks module on shutdown. */
export function closeChannelLink(): void {
  setChannelTaskHooks(null);
}

/**
 * Used by the MCP bridge (`tasks_send_message`): sends a message for a task
 * through a Channels account. Unconfirmed mandates only ever produce drafts;
 * the account's agentSend decides the rest. Replies and new e-mails keep the
 * task tag in the subject; the thread is linked once delivered.
 */
export async function sendTaskMessage(input: {
  taskId: number;
  accountId?: string;
  to?: string;
  subject?: string;
  text: string;
  replyToMessageId?: string;
  sessionId?: string | null;
}): Promise<{ outboxId: string; status: string; to: string; subject: string | null; detail: string | null }> {
  const task = tasksDb.get(input.taskId);
  if (!task) throw new AppError(`Task #${input.taskId} not found.`, { code: 'TASK_NOT_FOUND', statusCode: 404 });
  if (!isOpen(task)) throw new AppError(`Task #${input.taskId} is closed.`, { code: 'TASK_CONFLICT', statusCode: 409 });

  const original = input.replyToMessageId ? channelMessagesDb.get(input.replyToMessageId) : null;
  if (input.replyToMessageId && !original) throw new AppError('The message to reply to was not found.', { code: 'CHANNEL_MESSAGE_NOT_FOUND', statusCode: 404 });
  const accountId = original?.account_id ?? input.accountId;
  if (!accountId) throw new AppError('account_id is required (see channels_list_accounts) unless you reply to a message.', { code: 'INVALID_TASK', statusCode: 400 });
  const account = channelAccountsDb.get(accountId);
  if (!account) throw new AppError('Channel account not found.', { code: 'CHANNEL_ACCOUNT_NOT_FOUND', statusCode: 404 });

  const raw = (() => {
    try {
      return original ? (JSON.parse(original.raw_json || '{}') as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  })();
  const to = (input.to?.trim() || (typeof raw.replyTo === 'string' && raw.replyTo.trim()) || original?.from_address || '').trim();
  if (!to) throw new AppError('to is required.', { code: 'INVALID_TASK', statusCode: 400 });

  let subject: string | null = input.subject?.trim() || null;
  if (!subject && original?.subject) subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
  if (account.type === 'email') {
    if (!subject) throw new AppError('An e-mail needs a subject.', { code: 'INVALID_TASK', statusCode: 400 });
    subject = taggedSubject(subject, task.id);
  }

  const row = await outboxService.createTaskMessage({
    taskId: task.id,
    accountId,
    to,
    subject,
    text: input.text,
    inReplyToMessageId: original?.id ?? null,
    sessionId: input.sessionId ?? null,
    forceDraft: task.mandate_confirmed !== 1,
  });

  const state = row.status === 'sent'
    ? 'Sent'
    : row.status === 'draft'
      ? (task.mandate_confirmed !== 1 ? 'Draft (mandate not confirmed yet) waits for approval' : 'Draft waits for approval')
      : `Not sent (${row.status_detail ?? row.status})`;
  taskEventsDb.add({
    taskId: task.id,
    author: 'agent',
    kind: 'message_out',
    text: `${state} → ${to}${subject ? `\nPředmět: ${subject}` : ''}\n\n${clip(row.text, DIARY_TEXT_LIMIT)}`,
    meta: { outboxId: row.id, accountId, status: row.status },
    sessionId: input.sessionId ?? null,
  });
  broadcastTasksUpdated({ taskId: task.id });
  return { outboxId: row.id, status: row.status, to, subject, detail: row.status_detail };
}

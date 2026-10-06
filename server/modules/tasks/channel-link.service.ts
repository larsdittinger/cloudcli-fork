import { outboxService, setChannelTaskHooks } from '@/modules/channels/index.js';
import type { ChannelMessageRow, ChannelOutboxRow } from '@/modules/channels/index.js';
import { channelAccountsDb, channelMessagesDb, channelOutboxDb, taskEventsDb, tasksDb, taskThreadsDb } from '@/modules/database/index.js';
import type { TaskRow } from '@/modules/database/index.js';
import { broadcastTasksUpdated } from '@/modules/tasks/tasks-broadcast.js';
import { queueWake } from '@/modules/tasks/wake-queue.js';
import { AppError } from '@/shared/utils.js';

/** Inbound text kept in the diary; the full message (and attachments) stays in Channels. */
const DIARY_TEXT_LIMIT = 4000;
/** `[T-12]` in a subject: rarer than `[#12]`, which helpdesks use too. */
const TAG_PATTERN = /\[T-(\d{1,9})\]/i;
/** Shared mail providers: a colleague at the same domain means nothing there. */
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'seznam.cz', 'email.cz', 'post.cz', 'centrum.cz', 'atlas.cz', 'volny.cz', 'tiscali.cz',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net',
]);
const AUTO_REPLY_SUBJECT = /^(automatic reply|auto(matick[áa])? odpov[ěe]ď|out of office|nep[řr][ií]tomnost|abwesenheit|auto:)/i;

function isOpen(task: TaskRow | null): task is TaskRow {
  return task !== null && task.status !== 'done' && task.status !== 'cancelled';
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n… (zkráceno, celé: channels_get_message)` : trimmed;
}

function tagFor(taskId: number): string {
  return `[T-${taskId}]`;
}

function domainOf(address: string): string {
  return address.toLowerCase().split('@')[1]?.trim() ?? '';
}

/**
 * A tag alone proves nothing (task numbers are small and guessable): it only
 * counts from someone the task already wrote to, or a colleague at the same
 * company domain.
 */
function knownCorrespondent(taskId: number, from: string): boolean {
  const sender = from.trim().toLowerCase();
  const recipients = channelOutboxDb.recipientsOfTask(taskId);
  if (recipients.includes(sender)) return true;
  const domain = domainOf(sender);
  return Boolean(domain) && !FREE_MAIL_DOMAINS.has(domain) && recipients.some((recipient) => domainOf(recipient) === domain);
}

function isAutoReply(message: ChannelMessageRow): boolean {
  try {
    if ((JSON.parse(message.raw_json || '{}') as { autoReply?: unknown }).autoReply === true) return true;
  } catch {
    // Not JSON: fall through to the subject.
  }
  return AUTO_REPLY_SUBJECT.test(message.subject ?? '');
}

/** Keeps the task tag in an e-mail subject so a reply outside the thread still finds the task. */
function taggedSubject(subject: string, taskId: number): string {
  return subject.includes(tagFor(taskId)) ? subject : `${subject} ${tagFor(taskId)}`.trim();
}

/**
 * A reply in a task's thread belongs to the task; so does a `[T-N]`-tagged
 * message from someone the task wrote to. Everything else stays with the rules.
 */
function routeInbound(message: ChannelMessageRow): number | null {
  const threadTask = tasksDb.get(taskThreadsDb.find(message.account_id, message.thread_key) ?? 0);
  const tagged = TAG_PATTERN.exec(message.subject ?? '');
  const taggedTask = tagged ? tasksDb.get(Number(tagged[1])) : null;
  const task = isOpen(threadTask)
    ? threadTask
    : isOpen(taggedTask) && knownCorrespondent(taggedTask.id, message.from_address) ? taggedTask : null;
  if (!task) return null;
  const automatic = isAutoReply(message);

  taskThreadsDb.link(message.account_id, message.thread_key, task.id);
  const from = message.from_name ? `${message.from_name} <${message.from_address}>` : message.from_address;
  const attachments = (() => {
    try {
      return (JSON.parse(message.attachments_json || '[]') as unknown[]).length;
    } catch {
      return 0;
    }
  })();
  const header = [
    automatic ? 'Automatic reply (out of office or similar) — did not wake the agent.' : null,
    `Od: ${from}`, message.subject ? `Předmět: ${message.subject}` : null, attachments ? `Přílohy: ${attachments} (channels_get_message)` : null,
  ]
    .filter(Boolean)
    .join('\n');
  taskEventsDb.add({
    taskId: task.id,
    author: 'external',
    kind: 'message_in',
    text: `${header}\n\n${clip(message.text, DIARY_TEXT_LIMIT)}`,
    meta: { messageId: message.id, accountId: message.account_id, from: message.from_address, subject: message.subject, channel: message.channel, automatic },
  });
  // An out-of-office answer is worth a line in the diary, not a run (and not a reply).
  if (automatic) broadcastTasksUpdated({ taskId: task.id });
  else queueWake(task.id, 'message');
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
  setChannelTaskHooks({ routeInbound, onSent, blocksAgentSend: (cwd) => tasksDb.listRunningIn(cwd).length > 0 });
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

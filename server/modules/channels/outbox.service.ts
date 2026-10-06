import { broadcastOutboxUpdated } from '@/modules/channels/channels-broadcast.js';
import { channelsService } from '@/modules/channels/channels.service.js';
import { getChannelTaskHooks } from '@/modules/channels/task-hooks.js';
import { whatsappThreadKey } from '@/modules/channels/thread-key.js';
import { parseJson } from '@/modules/channels/types.js';
import type { ChannelMessageRow, ChannelOutboxRow, ChannelRuleRow, OutboxStatus } from '@/modules/channels/types.js';
import { channelAccountsDb, channelMessagesDb, channelOutboxDb, channelRulesDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

/** Minimum gap between two sends on one account — keeps a looping agent from spraying messages. */
export const SEND_MIN_GAP_MS = 2_000;

const lastSendAt = new Map<string, number>();
const sendQueues = new Map<string, Promise<void>>();

let sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function announce(row: ChannelOutboxRow): ChannelOutboxRow {
  broadcastOutboxUpdated({ outboxId: row.id, sessionId: row.session_id, status: row.status });
  return row;
}

function requireOutbox(id: string): ChannelOutboxRow {
  const row = channelOutboxDb.get(id);
  if (!row) {
    throw new AppError('Outgoing message not found.', { code: 'OUTBOX_NOT_FOUND', statusCode: 404 });
  }
  return row;
}

function replyTarget(message: ChannelMessageRow): { to: string; subject: string | null } {
  const raw = parseJson<Record<string, unknown>>(message.raw_json, {});
  const to = typeof raw.replyTo === 'string' && raw.replyTo.trim() ? raw.replyTo.trim() : message.from_address;
  const subject = message.channel === 'email' && message.subject
    ? (/^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`)
    : null;
  return { to, subject };
}

/**
 * Where replies to a delivered message will arrive: the thread it answered,
 * else the e-mail's own Message-ID (the root of the reply's References) or the
 * WhatsApp chat. Webhooks have no general rule; their tasks match by tag.
 */
function replyThreadKey(row: ChannelOutboxRow): string | null {
  if (row.in_reply_to_message_id) return channelMessagesDb.get(row.in_reply_to_message_id)?.thread_key ?? null;
  const type = channelAccountsDb.get(row.account_id)?.type;
  if (type === 'email' && row.external_id) return row.external_id.trim().replace(/^<|>$/g, '').toLowerCase() || null;
  if (type === 'whatsapp') {
    const digits = row.to_address.replace(/\D/g, '');
    return row.to_address.includes('@') ? whatsappThreadKey(row.to_address) : digits ? whatsappThreadKey(`${digits}@s.whatsapp.net`) : null;
  }
  return null;
}

function notifyTaskSent(row: ChannelOutboxRow, afterApproval: boolean): void {
  if (row.task_id === null || row.status !== 'sent') return;
  try {
    getChannelTaskHooks()?.onSent(row, { threadKey: replyThreadKey(row), afterApproval });
  } catch (error) {
    console.error('[Channels] Task hook after send failed', { outboxId: row.id, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Sends through the account's adapter, serialising sends per account with the minimum gap. */
async function deliverNow(id: string, options: { afterApproval?: boolean } = {}): Promise<ChannelOutboxRow> {
  const row = requireOutbox(id);
  const previous = sendQueues.get(row.account_id) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  sendQueues.set(row.account_id, previous.then(() => mine));

  await previous;
  try {
    const wait = SEND_MIN_GAP_MS - (Date.now() - (lastSendAt.get(row.account_id) ?? 0));
    if (wait > 0) await sleep(wait);

    channelOutboxDb.setStatus(id, 'sending');
    announce(requireOutbox(id));

    const adapter = channelsService.getAdapter(row.account_id);
    if (!adapter) {
      channelOutboxDb.setStatus(id, 'failed', { detail: 'The account is not connected.' });
      return announce(requireOutbox(id));
    }
    const inReplyTo = row.in_reply_to_message_id ? channelMessagesDb.get(row.in_reply_to_message_id) : null;
    try {
      const { externalId } = await adapter.send({ to: row.to_address, text: row.text, subject: row.subject ?? undefined, inReplyTo, outboxId: row.id, action: row.action });
      lastSendAt.set(row.account_id, Date.now());
      channelOutboxDb.setStatus(id, 'sent', { externalId });
    } catch (error) {
      channelOutboxDb.setStatus(id, 'failed', { detail: error instanceof Error ? error.message : String(error) });
    }
    const final = requireOutbox(id);
    notifyTaskSent(final, options.afterApproval === true);
    return announce(final);
  } finally {
    release();
  }
}

function ruleForMessage(message: ChannelMessageRow): ChannelRuleRow | null {
  return message.rule_id ? channelRulesDb.get(message.rule_id) : null;
}

export const outboxService = {
  /** An answer to one inbound message; the message's rule decides whether it goes out now, waits for approval, or is refused. */
  async createReply(input: { messageId: string; text: string; action?: 'reply' | 'escalate'; createdBy: 'agent' | 'user' }): Promise<ChannelOutboxRow> {
    const message = channelMessagesDb.get(input.messageId);
    if (!message) {
      throw new AppError('The message to reply to was not found.', { code: 'CHANNEL_MESSAGE_NOT_FOUND', statusCode: 404 });
    }
    const action = input.action ?? 'reply';
    if (action !== 'reply' && action !== 'escalate') {
      throw new AppError('Unknown reply action.', { code: 'REPLY_ACTION_INVALID', statusCode: 400 });
    }
    if (action === 'escalate' && message.channel !== 'webhook') {
      throw new AppError('Human handoffs are supported only for webhook messages.', { code: 'REPLY_ACTION_INVALID', statusCode: 400 });
    }
    if (action === 'escalate') {
      const account = channelAccountsDb.get(message.account_id);
      if (!account || parseJson<Record<string, unknown>>(account.config, {}).allowEscalation !== true) {
        throw new AppError('Enable human handoffs on this webhook account first.', { code: 'ESCALATION_NOT_ALLOWED', statusCode: 403 });
      }
    }
    const text = input.text.trim();
    if (!text) {
      throw new AppError('A reply needs some text.', { code: 'OUTBOX_TEXT_REQUIRED', statusCode: 400 });
    }
    const rule = ruleForMessage(message);
    const mode = input.createdBy === 'user' ? 'auto' : (rule?.reply_mode ?? 'draft');
    if (mode === 'none') {
      throw new AppError('Replies are not allowed for the rule that handled this message.', { code: 'REPLY_NOT_ALLOWED', statusCode: 403 });
    }
    const { to, subject } = replyTarget(message);
    const row = channelOutboxDb.create({
      accountId: message.account_id,
      sessionId: message.session_id,
      inReplyToMessageId: message.id,
      to,
      subject,
      text,
      action,
      status: mode === 'auto' ? 'approved' : 'draft',
      createdBy: input.createdBy,
    });
    if (mode === 'auto') {
      return deliverNow(row.id);
    }
    return announce(row);
  },

  /** A free-form message; the account's agentSend setting governs agents, users may always send. */
  async createSend(input: {
    accountId: string;
    to: string;
    text: string;
    subject?: string | null;
    sessionId?: string | null;
    createdBy: 'agent' | 'user';
  }): Promise<ChannelOutboxRow> {
    const account = channelAccountsDb.get(input.accountId);
    if (!account) {
      throw new AppError('Channel account not found.', { code: 'CHANNEL_ACCOUNT_NOT_FOUND', statusCode: 404 });
    }
    const text = input.text.trim();
    const to = input.to.trim();
    if (!text || !to) {
      throw new AppError('A message needs a recipient and some text.', { code: 'OUTBOX_TEXT_REQUIRED', statusCode: 400 });
    }
    const mode = input.createdBy === 'user' ? 'auto' : account.agent_send;
    if (mode === 'off') {
      throw new AppError(`Agents may not send messages through "${account.label}". Enable it in Settings → Channels.`, { code: 'SEND_NOT_ALLOWED', statusCode: 403 });
    }
    const row = channelOutboxDb.create({
      accountId: account.id,
      sessionId: input.sessionId ?? null,
      to,
      subject: input.subject ?? null,
      text,
      status: mode === 'auto' ? 'approved' : 'draft',
      createdBy: input.createdBy,
    });
    if (mode === 'auto') {
      return deliverNow(row.id);
    }
    return announce(row);
  },

  /**
   * A message that belongs to a long-running task (Tasks module). The account's
   * agentSend decides like for any agent send; `forceDraft` (an unconfirmed
   * task mandate) keeps it a draft regardless. Answers `inReplyToMessageId`
   * in its thread when given.
   */
  async createTaskMessage(input: {
    taskId: number;
    accountId: string;
    to: string;
    text: string;
    subject?: string | null;
    inReplyToMessageId?: string | null;
    sessionId?: string | null;
    forceDraft?: boolean;
  }): Promise<ChannelOutboxRow> {
    const account = channelAccountsDb.get(input.accountId);
    if (!account) {
      throw new AppError('Channel account not found.', { code: 'CHANNEL_ACCOUNT_NOT_FOUND', statusCode: 404 });
    }
    if (account.agent_send === 'off') {
      throw new AppError(`Agents may not send messages through "${account.label}". Enable it in Settings → Channels.`, { code: 'SEND_NOT_ALLOWED', statusCode: 403 });
    }
    const text = input.text.trim();
    const to = input.to.trim();
    if (!text || !to) {
      throw new AppError('A message needs a recipient and some text.', { code: 'OUTBOX_TEXT_REQUIRED', statusCode: 400 });
    }
    const auto = account.agent_send === 'auto' && !input.forceDraft;
    const row = channelOutboxDb.create({
      accountId: account.id,
      sessionId: input.sessionId ?? null,
      inReplyToMessageId: input.inReplyToMessageId ?? null,
      to,
      subject: input.subject ?? null,
      text,
      status: auto ? 'approved' : 'draft',
      createdBy: 'agent',
      taskId: input.taskId,
    });
    return auto ? deliverNow(row.id) : announce(row);
  },

  async approve(id: string, patch: { text?: string } = {}): Promise<ChannelOutboxRow> {
    const row = requireOutbox(id);
    if (row.status !== 'draft' && row.status !== 'failed') {
      throw new AppError('Only drafts and failed messages can be sent.', { code: 'OUTBOX_NOT_APPROVABLE', statusCode: 409 });
    }
    const text = typeof patch.text === 'string' && patch.text.trim() ? patch.text.trim() : row.text;
    channelOutboxDb.setStatus(id, 'approved', { text });
    return deliverNow(id, { afterApproval: true });
  },

  discard(id: string): ChannelOutboxRow {
    const row = requireOutbox(id);
    if (row.status === 'sent' || row.status === 'sending') {
      throw new AppError('That message was already sent.', { code: 'OUTBOX_NOT_DISCARDABLE', statusCode: 409 });
    }
    channelOutboxDb.setStatus(id, 'discarded');
    return announce(requireOutbox(id));
  },

  async retry(id: string): Promise<ChannelOutboxRow> {
    return this.approve(id);
  },

  list(filter: { status?: OutboxStatus[]; sessionId?: string; limit?: number } = {}): ChannelOutboxRow[] {
    return channelOutboxDb.list(filter);
  },

  countDrafts(): number {
    return channelOutboxDb.countDrafts();
  },

  recoverAfterRestart(): number {
    return channelOutboxDb.failSending();
  },
};

/** @internal test hook: replace the delay so the rate limit can be asserted without waiting. */
export function __setSleep(next: (ms: number) => Promise<void>): void {
  sleep = next;
}

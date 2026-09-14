import { randomUUID } from 'node:crypto';

import { broadcastInboxUpdated } from '@/modules/channels/channels-broadcast.js';
import { buildTemplateVars, channelLabel, DEFAULT_PROMPT_TEMPLATE, renderPromptTemplate } from '@/modules/channels/prompt-template.js';
import { parseJson } from '@/modules/channels/types.js';
import type { ChannelMessageRow, ChannelRuleRow, InboundAttachment, InboundMessage } from '@/modules/channels/types.js';
import {
  channelAccountsDb,
  channelMessagesDb,
  channelRulesDb,
  channelThreadsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { broadcastSessionUpserted, chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

/** Queued messages are retried this often; a run rarely ends between two ticks unnoticed. */
const POLL_INTERVAL_MS = 15_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let dispatchInFlight = false;

export type DispatchResult = { started: boolean; sessionId: string | null; error: string | null };

export function rowToInboundMessage(row: ChannelMessageRow): InboundMessage {
  return {
    id: row.id,
    accountId: row.account_id,
    channel: row.channel,
    externalId: row.external_id,
    threadKey: row.thread_key,
    from: { address: row.from_address, name: row.from_name ?? undefined },
    to: parseJson<string[]>(row.to_json, []),
    subject: row.subject ?? undefined,
    text: row.text,
    html: row.html ?? undefined,
    isGroup: row.is_group === 1,
    attachments: parseJson<InboundAttachment[]>(row.attachments_json, []),
    receivedAt: row.received_at,
    raw: parseJson<Record<string, unknown>>(row.raw_json, {}),
  };
}

function sessionName(message: ChannelMessageRow): string {
  const who = message.from_name || message.from_address;
  const what = message.subject || message.text.replace(/\s+/g, ' ').trim().slice(0, 40);
  return `${channelLabel(message.channel)}: ${who}${what ? ` — ${what}` : ''}`.slice(0, 80);
}

/**
 * Finds the chat a message continues, or creates one.
 *
 * `thread` keys on the conversation (e-mail thread, WhatsApp chat), `sender`
 * on who wrote, `new` never reuses. A remembered session that has since been
 * deleted is replaced rather than failing the message.
 */
export async function resolveSessionForMessage(
  rule: ChannelRuleRow,
  message: ChannelMessageRow,
): Promise<{ sessionId: string; created: boolean }> {
  const key = rule.conversation === 'thread'
    ? message.thread_key
    : rule.conversation === 'sender'
      ? message.from_address.toLowerCase()
      : null;

  if (key) {
    const remembered = channelThreadsDb.get(rule.id, key);
    if (remembered && sessionsDb.getSessionById(remembered)) {
      return { sessionId: remembered, created: false };
    }
  }

  const sessionId = randomUUID();
  sessionsDb.createAppSession(sessionId, rule.provider, rule.project_path, sessionName(message), rule.owner_user_id);
  if (key) {
    channelThreadsDb.set(rule.id, key, sessionId);
  }
  await broadcastSessionUpserted(sessionId);
  return { sessionId, created: true };
}

function runOptions(rule: ChannelRuleRow): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (rule.model) options.model = rule.model;
  if (rule.effort) options.effort = rule.effort;
  if (rule.permission_mode && rule.permission_mode !== 'default') options.permissionMode = rule.permission_mode;
  return options;
}

function fail(messageId: string, error: string): DispatchResult {
  channelMessagesDb.setStatus(messageId, 'failed', error);
  broadcastInboxUpdated({ messageId, status: 'failed' });
  return { started: false, sessionId: null, error };
}

/**
 * Sends one inbound message into its chat as an agent turn.
 *
 * When the chat is busy the message waits as `queued`; the poll sends it once
 * the run ends. Nothing is ever interrupted — a message is context for the
 * agent, not an order that outranks what it is doing.
 */
export async function dispatchMessage(
  messageId: string,
  ruleId: string,
  runtime: ProviderRuntimeGateway,
  options: { manual?: boolean } = {},
): Promise<DispatchResult> {
  const message = channelMessagesDb.get(messageId);
  if (!message) {
    return { started: false, sessionId: null, error: 'The message no longer exists.' };
  }
  const rule = channelRulesDb.get(ruleId);
  if (!rule) {
    return fail(messageId, 'The rule no longer exists.');
  }
  const account = channelAccountsDb.get(message.account_id);
  if (!account) {
    return fail(messageId, 'The account no longer exists.');
  }

  let sessionId: string;
  try {
    ({ sessionId } = await resolveSessionForMessage(rule, message));
  } catch (error) {
    return fail(messageId, error instanceof Error ? error.message : String(error));
  }
  channelMessagesDb.attachRule(messageId, rule.id, sessionId);

  if (chatRunRegistry.isProcessing(sessionId)) {
    channelMessagesDb.setStatus(messageId, 'queued', null);
    broadcastInboxUpdated({ messageId, status: 'queued', sessionId });
    return { started: false, sessionId, error: null };
  }

  const prompt = renderPromptTemplate(
    rule.prompt_template.trim() || DEFAULT_PROMPT_TEMPLATE,
    buildTemplateVars({ message: rowToInboundMessage(message), accountLabel: account.label, replyMode: rule.reply_mode }),
  );

  let result: { started: boolean; error: string | null };
  try {
    result = await runDetachedChatTurn(
      { sessionId, userId: rule.owner_user_id, content: prompt, options: runOptions(rule) },
      { runtime },
    );
  } catch (error) {
    result = { started: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (result.started && !result.error) {
    const status = options.manual ? 'manual' : 'dispatched';
    channelMessagesDb.setStatus(messageId, status, null);
    broadcastInboxUpdated({ messageId, status, sessionId });
    return { started: true, sessionId, error: null };
  }
  if (result.error === 'A run was already in progress for this session.') {
    channelMessagesDb.setStatus(messageId, 'queued', null);
    broadcastInboxUpdated({ messageId, status: 'queued', sessionId });
    return { started: false, sessionId, error: null };
  }
  const detail = result.error ?? 'The agent run failed to start.';
  channelMessagesDb.setStatus(messageId, 'failed', detail);
  broadcastInboxUpdated({ messageId, status: 'failed', sessionId });
  return { started: false, sessionId, error: detail };
}

/** Sends the oldest queued message of every idle chat. */
export async function dispatchQueuedMessages(runtime: ProviderRuntimeGateway): Promise<number> {
  const queued = channelMessagesDb.listQueued();
  const seenSessions = new Set<string>();
  let sent = 0;

  for (const row of queued) {
    if (!row.rule_id) {
      channelMessagesDb.setStatus(row.id, 'failed', 'Queued without a rule.');
      continue;
    }
    const sessionKey = row.session_id ?? `rule:${row.rule_id}:${row.thread_key}`;
    if (seenSessions.has(sessionKey)) continue;
    seenSessions.add(sessionKey);
    if (row.session_id && chatRunRegistry.isProcessing(row.session_id)) continue;

    const result = await dispatchMessage(row.id, row.rule_id, runtime);
    if (result.started) sent += 1;
  }

  return sent;
}

export function initializeChannelsDispatcher(runtime: ProviderRuntimeGateway): void {
  if (pollTimer) return;

  const poll = () => {
    if (dispatchInFlight) return;
    dispatchInFlight = true;
    void dispatchQueuedMessages(runtime)
      .catch((error: unknown) => {
        console.error('[Channels] Queue pass failed', { error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        dispatchInFlight = false;
      });
  };

  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  pollTimer.unref?.();
  poll();
}

export function closeChannelsDispatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

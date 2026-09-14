import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import type {
  AccountStatus,
  AgentSendMode,
  ChannelAccountRow,
  ChannelMessageRow,
  ChannelOutboxRow,
  ChannelRuleRow,
  ChannelType,
  InboundMessage,
  MessageStatus,
  OutboxStatus,
  RuleInput,
} from '@/modules/channels/index.js';

const ACCOUNT_COLUMNS =
  'id, type, label, enabled, config, secrets, agent_send, status, status_detail, last_seen_at, created_at, updated_at';
const RULE_COLUMNS =
  'id, name, enabled, position, account_id, channel, conditions, project_path, provider, model, effort, permission_mode, prompt_template, conversation, reply_mode, reply_scope, owner_user_id, created_at, updated_at';
const MESSAGE_COLUMNS =
  'id, account_id, channel, external_id, thread_key, from_address, from_name, to_json, subject, text, html, is_group, attachments_json, raw_json, received_at, rule_id, session_id, status, status_detail, created_at';
const OUTBOX_COLUMNS =
  'id, account_id, session_id, in_reply_to_message_id, to_address, subject, text, status, status_detail, external_id, created_by, created_at, sent_at';

export const channelAccountsDb = {
  create(input: {
    type: ChannelType;
    label: string;
    config: Record<string, unknown>;
    secrets: Record<string, unknown>;
    agentSend?: AgentSendMode;
  }): ChannelAccountRow {
    const db = getConnection();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO channel_accounts (id, type, label, enabled, config, secrets, agent_send, status)
       VALUES (?, ?, ?, 1, ?, ?, ?, 'disconnected')`,
    ).run(id, input.type, input.label, JSON.stringify(input.config ?? {}), JSON.stringify(input.secrets ?? {}), input.agentSend ?? 'off');
    return this.get(id) as ChannelAccountRow;
  },

  update(
    id: string,
    patch: Partial<{
      label: string;
      enabled: boolean;
      config: Record<string, unknown>;
      secrets: Record<string, unknown>;
      agentSend: AgentSendMode;
    }>,
  ): ChannelAccountRow | null {
    const current = this.get(id);
    if (!current) return null;
    getConnection()
      .prepare(
        `UPDATE channel_accounts
         SET label = ?, enabled = ?, config = ?, secrets = ?, agent_send = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(
        patch.label ?? current.label,
        patch.enabled === undefined ? current.enabled : (patch.enabled ? 1 : 0),
        patch.config ? JSON.stringify(patch.config) : current.config,
        patch.secrets ? JSON.stringify(patch.secrets) : current.secrets,
        patch.agentSend ?? current.agent_send,
        id,
      );
    return this.get(id);
  },

  setStatus(id: string, status: AccountStatus, detail: string | null = null): void {
    getConnection()
      .prepare(
        `UPDATE channel_accounts
         SET status = ?, status_detail = ?,
             last_seen_at = CASE WHEN ? = 'connected' THEN CURRENT_TIMESTAMP ELSE last_seen_at END
         WHERE id = ?`,
      )
      .run(status, detail, status, id);
  },

  get(id: string): ChannelAccountRow | null {
    return (getConnection().prepare(`SELECT ${ACCOUNT_COLUMNS} FROM channel_accounts WHERE id = ?`).get(id) as ChannelAccountRow | undefined) ?? null;
  },

  list(): ChannelAccountRow[] {
    return getConnection().prepare(`SELECT ${ACCOUNT_COLUMNS} FROM channel_accounts ORDER BY created_at ASC`).all() as ChannelAccountRow[];
  },

  delete(id: string): boolean {
    return getConnection().prepare('DELETE FROM channel_accounts WHERE id = ?').run(id).changes > 0;
  },
};

function ruleValues(input: RuleInput) {
  return {
    name: input.name,
    enabled: input.enabled === false ? 0 : 1,
    account_id: input.accountId ?? null,
    channel: input.channel ?? null,
    conditions: JSON.stringify(input.conditions ?? {}),
    project_path: input.projectPath,
    provider: input.provider,
    model: input.model ?? null,
    effort: input.effort ?? null,
    permission_mode: input.permissionMode ?? 'default',
    prompt_template: input.promptTemplate ?? '',
    conversation: input.conversation ?? 'thread',
    reply_mode: input.replyMode ?? 'none',
    reply_scope: input.replyScope ?? 'sender',
    owner_user_id: input.ownerUserId ?? null,
  };
}

export const channelRulesDb = {
  create(input: RuleInput): ChannelRuleRow {
    const db = getConnection();
    const id = randomUUID();
    const values = ruleValues(input);
    const maxPosition = (db.prepare('SELECT COALESCE(MAX(position), 0) AS max FROM channel_rules').get() as { max: number }).max;
    db.prepare(
      `INSERT INTO channel_rules (id, name, enabled, position, account_id, channel, conditions, project_path, provider, model, effort,
         permission_mode, prompt_template, conversation, reply_mode, reply_scope, owner_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, values.name, values.enabled, maxPosition + 1, values.account_id, values.channel, values.conditions,
      values.project_path, values.provider, values.model, values.effort, values.permission_mode,
      values.prompt_template, values.conversation, values.reply_mode, values.reply_scope, values.owner_user_id,
    );
    return this.get(id) as ChannelRuleRow;
  },

  update(id: string, patch: Partial<RuleInput>): ChannelRuleRow | null {
    const current = this.get(id);
    if (!current) return null;
    const merged: RuleInput = {
      name: patch.name ?? current.name,
      enabled: patch.enabled ?? current.enabled === 1,
      accountId: patch.accountId === undefined ? current.account_id : patch.accountId,
      channel: patch.channel === undefined ? current.channel : patch.channel,
      conditions: patch.conditions ?? JSON.parse(current.conditions),
      projectPath: patch.projectPath ?? current.project_path,
      provider: patch.provider ?? current.provider,
      model: patch.model === undefined ? current.model : patch.model,
      effort: patch.effort === undefined ? current.effort : patch.effort,
      permissionMode: patch.permissionMode ?? current.permission_mode,
      promptTemplate: patch.promptTemplate ?? current.prompt_template,
      conversation: patch.conversation ?? current.conversation,
      replyMode: patch.replyMode ?? current.reply_mode,
      replyScope: patch.replyScope ?? current.reply_scope,
      ownerUserId: patch.ownerUserId === undefined ? current.owner_user_id : patch.ownerUserId,
    };
    const values = ruleValues(merged);
    getConnection()
      .prepare(
        `UPDATE channel_rules SET name = ?, enabled = ?, account_id = ?, channel = ?, conditions = ?, project_path = ?, provider = ?,
           model = ?, effort = ?, permission_mode = ?, prompt_template = ?, conversation = ?, reply_mode = ?, reply_scope = ?,
           owner_user_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(
        values.name, values.enabled, values.account_id, values.channel, values.conditions, values.project_path, values.provider,
        values.model, values.effort, values.permission_mode, values.prompt_template, values.conversation, values.reply_mode,
        values.reply_scope, values.owner_user_id, id,
      );
    return this.get(id);
  },

  get(id: string): ChannelRuleRow | null {
    return (getConnection().prepare(`SELECT ${RULE_COLUMNS} FROM channel_rules WHERE id = ?`).get(id) as ChannelRuleRow | undefined) ?? null;
  },

  listOrdered(): ChannelRuleRow[] {
    return getConnection().prepare(`SELECT ${RULE_COLUMNS} FROM channel_rules ORDER BY position ASC, created_at ASC`).all() as ChannelRuleRow[];
  },

  delete(id: string): boolean {
    return getConnection().prepare('DELETE FROM channel_rules WHERE id = ?').run(id).changes > 0;
  },

  /** Rewrites positions so `ids` come first in the given order; rules not listed keep their relative order after them. */
  reorder(ids: string[]): void {
    const db = getConnection();
    const update = db.prepare('UPDATE channel_rules SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const rest = this.listOrdered().map((rule) => rule.id).filter((id) => !ids.includes(id));
    db.transaction(() => {
      [...ids, ...rest].forEach((id, index) => update.run(index + 1, id));
    })();
  },
};

export const channelMessagesDb = {
  /** Returns null when the account already has a message with this external id. */
  insert(message: InboundMessage, status: MessageStatus): ChannelMessageRow | null {
    const db = getConnection();
    try {
      db.prepare(
        `INSERT INTO channel_messages (id, account_id, channel, external_id, thread_key, from_address, from_name, to_json, subject, text, html,
           is_group, attachments_json, raw_json, received_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        message.id, message.accountId, message.channel, message.externalId, message.threadKey,
        message.from.address, message.from.name ?? null, JSON.stringify(message.to ?? []), message.subject ?? null,
        message.text, message.html ?? null, message.isGroup ? 1 : 0, JSON.stringify(message.attachments ?? []),
        JSON.stringify(message.raw ?? {}), message.receivedAt, status,
      );
    } catch (error) {
      if (String(error).includes('UNIQUE')) return null;
      throw error;
    }
    return this.get(message.id);
  },

  get(id: string): ChannelMessageRow | null {
    return (getConnection().prepare(`SELECT ${MESSAGE_COLUMNS} FROM channel_messages WHERE id = ?`).get(id) as ChannelMessageRow | undefined) ?? null;
  },

  list(filter: { accountId?: string; status?: MessageStatus; limit?: number; before?: string } = {}): ChannelMessageRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.accountId) { clauses.push('account_id = ?'); params.push(filter.accountId); }
    if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
    if (filter.before) { clauses.push('received_at < ?'); params.push(filter.before); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(Math.min(Math.max(filter.limit ?? 50, 1), 500));
    return getConnection()
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM channel_messages ${where} ORDER BY received_at DESC LIMIT ?`)
      .all(...params) as ChannelMessageRow[];
  },

  setStatus(id: string, status: MessageStatus, detail: string | null = null): void {
    getConnection().prepare('UPDATE channel_messages SET status = ?, status_detail = ? WHERE id = ?').run(status, detail, id);
  },

  attachRule(id: string, ruleId: string | null, sessionId: string | null): void {
    getConnection().prepare('UPDATE channel_messages SET rule_id = ?, session_id = ? WHERE id = ?').run(ruleId, sessionId, id);
  },

  listQueued(): ChannelMessageRow[] {
    return getConnection()
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM channel_messages WHERE status = 'queued' ORDER BY received_at ASC`)
      .all() as ChannelMessageRow[];
  },

  /** The message that started a chat: the oldest one attached to the session. */
  getBySession(sessionId: string): ChannelMessageRow | null {
    return (getConnection()
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM channel_messages WHERE session_id = ? ORDER BY received_at ASC LIMIT 1`)
      .get(sessionId) as ChannelMessageRow | undefined) ?? null;
  },

  listByThread(accountId: string, threadKey: string, limit = 20): ChannelMessageRow[] {
    return getConnection()
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM channel_messages WHERE account_id = ? AND thread_key = ? ORDER BY received_at DESC LIMIT ?`)
      .all(accountId, threadKey, limit) as ChannelMessageRow[];
  },

  countByStatus(): Record<MessageStatus, number> {
    const counts: Record<MessageStatus, number> = { unmatched: 0, ignored: 0, queued: 0, dispatched: 0, failed: 0, manual: 0 };
    const rows = getConnection().prepare('SELECT status, COUNT(*) AS count FROM channel_messages GROUP BY status').all() as Array<{ status: MessageStatus; count: number }>;
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  },

  /** Deletes messages older than the cutoff and returns their ids so attachment folders can go too. */
  deleteOlderThan(isoDate: string): string[] {
    const db = getConnection();
    const ids = (db.prepare('SELECT id FROM channel_messages WHERE received_at < ?').all(isoDate) as Array<{ id: string }>).map((row) => row.id);
    if (ids.length) db.prepare('DELETE FROM channel_messages WHERE received_at < ?').run(isoDate);
    return ids;
  },
};

export const channelThreadsDb = {
  get(ruleId: string, threadKey: string): string | null {
    const row = getConnection().prepare('SELECT session_id FROM channel_threads WHERE rule_id = ? AND thread_key = ?').get(ruleId, threadKey) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  },
  set(ruleId: string, threadKey: string, sessionId: string): void {
    getConnection()
      .prepare(
        `INSERT INTO channel_threads (rule_id, thread_key, session_id) VALUES (?, ?, ?)
         ON CONFLICT(rule_id, thread_key) DO UPDATE SET session_id = excluded.session_id, updated_at = CURRENT_TIMESTAMP`,
      )
      .run(ruleId, threadKey, sessionId);
  },
  deleteBySession(sessionId: string): void {
    getConnection().prepare('DELETE FROM channel_threads WHERE session_id = ?').run(sessionId);
  },
};

export const channelOutboxDb = {
  create(input: {
    accountId: string;
    sessionId?: string | null;
    inReplyToMessageId?: string | null;
    to: string;
    subject?: string | null;
    text: string;
    status: OutboxStatus;
    createdBy: 'agent' | 'user';
  }): ChannelOutboxRow {
    const id = randomUUID();
    getConnection()
      .prepare(
        `INSERT INTO channel_outbox (id, account_id, session_id, in_reply_to_message_id, to_address, subject, text, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.accountId, input.sessionId ?? null, input.inReplyToMessageId ?? null, input.to, input.subject ?? null, input.text, input.status, input.createdBy);
    return this.get(id) as ChannelOutboxRow;
  },

  get(id: string): ChannelOutboxRow | null {
    return (getConnection().prepare(`SELECT ${OUTBOX_COLUMNS} FROM channel_outbox WHERE id = ?`).get(id) as ChannelOutboxRow | undefined) ?? null;
  },

  list(filter: { status?: OutboxStatus[]; sessionId?: string; limit?: number } = {}): ChannelOutboxRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.status?.length) {
      clauses.push(`status IN (${filter.status.map(() => '?').join(', ')})`);
      params.push(...filter.status);
    }
    if (filter.sessionId) { clauses.push('session_id = ?'); params.push(filter.sessionId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(Math.min(Math.max(filter.limit ?? 100, 1), 500));
    return getConnection()
      .prepare(`SELECT ${OUTBOX_COLUMNS} FROM channel_outbox ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as ChannelOutboxRow[];
  },

  setStatus(id: string, status: OutboxStatus, patch: { detail?: string | null; externalId?: string | null; text?: string } = {}): void {
    const current = this.get(id);
    if (!current) return;
    getConnection()
      .prepare(
        `UPDATE channel_outbox SET status = ?, status_detail = ?, external_id = ?, text = ?,
           sent_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE sent_at END
         WHERE id = ?`,
      )
      .run(status, patch.detail ?? null, patch.externalId ?? current.external_id, patch.text ?? current.text, status, id);
  },

  countDrafts(): number {
    return (getConnection().prepare(`SELECT COUNT(*) AS count FROM channel_outbox WHERE status = 'draft'`).get() as { count: number }).count;
  },

  /** After a restart nothing is still being sent; mark those rows failed so the user can retry. */
  failSending(): number {
    return getConnection()
      .prepare(`UPDATE channel_outbox SET status = 'failed', status_detail = 'The server restarted while this was being sent.' WHERE status = 'sending'`)
      .run().changes;
  },
};

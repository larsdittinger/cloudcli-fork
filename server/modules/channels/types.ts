/**
 * Channels — shared types.
 *
 * A channel account (an IMAP mailbox, a WhatsApp number, a webhook endpoint)
 * delivers inbound messages; rules decide which project and prompt an inbound
 * message starts an agent turn in; the outbox holds what agents send back.
 */

export type ChannelType = 'email' | 'whatsapp' | 'webhook';

export type AccountStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'needs_pairing';

/** Whether an agent may send free-form messages through an account (replies are governed by the rule instead). */
export type AgentSendMode = 'off' | 'draft' | 'auto';

export type MessageStatus = 'unmatched' | 'ignored' | 'queued' | 'dispatched' | 'failed' | 'manual';

export type OutboxStatus = 'draft' | 'approved' | 'sending' | 'sent' | 'failed' | 'discarded';

/** How a follow-up message finds its chat: by thread, by sender, or never (always a new chat). */
export type ConversationMode = 'thread' | 'sender' | 'new';

export type ReplyMode = 'none' | 'draft' | 'auto';

export type ReplyScope = 'sender' | 'anyone';

export type PermissionMode = 'default' | 'bypassPermissions' | 'acceptEdits' | 'plan';

export type InboundAttachment = { name: string; mime: string; size: number; path: string };

export type InboundMessage = {
  id: string;
  accountId: string;
  channel: ChannelType;
  /** Provider-native id (Message-ID, WhatsApp key.id, webhook payload id) — deduplicated per account. */
  externalId: string;
  /** What a follow-up shares with this message: the e-mail thread root, the WhatsApp chat JID. */
  threadKey: string;
  from: { address: string; name?: string };
  to: string[];
  subject?: string;
  text: string;
  html?: string;
  isGroup: boolean;
  attachments: InboundAttachment[];
  receivedAt: string;
  raw: Record<string, unknown>;
};

export type RuleConditions = {
  senders?: string[];
  excludeSenders?: string[];
  subject?: { contains?: string[]; regex?: string };
  text?: { contains?: string[]; regex?: string };
  isGroup?: boolean;
  hasAttachments?: boolean;
  mentionsMe?: boolean;
};

export type RuleInput = {
  name: string;
  enabled?: boolean;
  accountId?: string | null;
  channel?: ChannelType | null;
  conditions: RuleConditions;
  projectPath: string;
  provider: string;
  model?: string | null;
  effort?: string | null;
  permissionMode?: PermissionMode;
  promptTemplate?: string;
  conversation?: ConversationMode;
  replyMode?: ReplyMode;
  replyScope?: ReplyScope;
  ownerUserId?: number | null;
};

export type ChannelAccountRow = {
  id: string;
  type: ChannelType;
  label: string;
  enabled: number;
  config: string;
  secrets: string;
  agent_send: AgentSendMode;
  status: AccountStatus;
  status_detail: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ChannelRuleRow = {
  id: string;
  name: string;
  enabled: number;
  position: number;
  account_id: string | null;
  channel: ChannelType | null;
  conditions: string;
  project_path: string;
  provider: string;
  model: string | null;
  effort: string | null;
  permission_mode: PermissionMode;
  prompt_template: string;
  conversation: ConversationMode;
  reply_mode: ReplyMode;
  reply_scope: ReplyScope;
  owner_user_id: number | null;
  created_at: string;
  updated_at: string;
};

export type ChannelMessageRow = {
  id: string;
  account_id: string;
  channel: ChannelType;
  external_id: string;
  thread_key: string;
  from_address: string;
  from_name: string | null;
  to_json: string;
  subject: string | null;
  text: string;
  html: string | null;
  is_group: number;
  attachments_json: string;
  raw_json: string;
  received_at: string;
  rule_id: string | null;
  session_id: string | null;
  status: MessageStatus;
  status_detail: string | null;
  created_at: string;
};

export type ChannelOutboxRow = {
  id: string;
  account_id: string;
  session_id: string | null;
  in_reply_to_message_id: string | null;
  to_address: string;
  subject: string | null;
  text: string;
  status: OutboxStatus;
  status_detail: string | null;
  external_id: string | null;
  created_by: 'agent' | 'user';
  created_at: string;
  sent_at: string | null;
};

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

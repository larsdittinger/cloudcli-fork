export type ChannelType = 'email' | 'whatsapp' | 'webhook';
export type AccountStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'needs_pairing';
export type AgentSendMode = 'off' | 'draft' | 'auto';
export type MessageStatus = 'unmatched' | 'ignored' | 'queued' | 'dispatched' | 'failed' | 'manual';
export type OutboxStatus = 'draft' | 'approved' | 'sending' | 'sent' | 'failed' | 'discarded';
export type ConversationMode = 'thread' | 'sender' | 'new';
export type ReplyMode = 'none' | 'draft' | 'auto';
export type ReplyScope = 'sender' | 'anyone';
export type PermissionMode = 'default' | 'bypassPermissions' | 'acceptEdits' | 'plan';

export type ChannelAccount = {
  id: string;
  type: ChannelType;
  label: string;
  enabled: boolean;
  config: Record<string, unknown>;
  hasSecrets: boolean;
  agentSend: AgentSendMode;
  status: AccountStatus;
  statusDetail: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  webhookUrlPath?: string;
  /** Present only in the response that created a webhook account. */
  secretsOnce?: Record<string, string>;
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

export type ChannelRule = {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  accountId: string | null;
  channel: ChannelType | null;
  conditions: RuleConditions;
  projectPath: string;
  provider: string;
  model: string | null;
  effort: string | null;
  permissionMode: PermissionMode;
  promptTemplate: string;
  conversation: ConversationMode;
  replyMode: ReplyMode;
  replyScope: ReplyScope;
  ownerUserId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ChannelRuleInput = Omit<ChannelRule, 'id' | 'position' | 'ownerUserId' | 'createdAt' | 'updatedAt'>;

export type ChannelMessage = {
  id: string;
  accountId: string;
  accountLabel: string | null;
  channel: ChannelType;
  externalId: string;
  threadKey: string;
  from: { address: string; name: string | null };
  to: string[];
  subject: string | null;
  text: string;
  html: string | null;
  isGroup: boolean;
  attachments: Array<{ name: string; mime: string; size: number; index: number }>;
  receivedAt: string;
  ruleId: string | null;
  ruleName: string | null;
  sessionId: string | null;
  status: MessageStatus;
  statusDetail: string | null;
};

export type OutboxItem = {
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

export type ChannelsSummary = {
  unmatched: number;
  queued: number;
  failed: number;
  drafts: number;
  enabled: boolean;
};

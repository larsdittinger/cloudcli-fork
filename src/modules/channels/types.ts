export type ChannelType = 'email' | 'whatsapp' | 'webhook';
export type AccountStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'needs_pairing';
export type AgentSendMode = 'off' | 'draft' | 'auto';
/** `task` = the message went to a long-running agent task instead of a rule. */
export type MessageStatus = 'unmatched' | 'held' | 'ignored' | 'queued' | 'dispatched' | 'failed' | 'manual' | 'task';
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
  /** Set while an agent's proposal awaits approval; the account stays disabled until then. */
  proposal: ChannelProposal | null;
};

/** What an agent attached to an account or rule it proposed through the cloudcli-channels MCP server. */
export type ChannelProposal = {
  note: string;
  /** The project the proposing agent ran in. */
  projectPath: string | null;
  createdAt: string;
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
  /** Senders whose replies go out without approval while replies are drafts. */
  autoReplySenders: string[];
  /** Matching messages wait for the owner's "Send to agent". */
  holdInbound: boolean;
  ownerUserId: number | null;
  /** Set while an agent's proposal awaits approval; the rule stays disabled until then. */
  proposal: ChannelProposal | null;
  createdAt: string;
  updatedAt: string;
};

export type ChannelRuleInput = Omit<ChannelRule, 'id' | 'position' | 'ownerUserId' | 'proposal' | 'createdAt' | 'updatedAt'>;

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
  /** The prompt-injection filter's findings; null when it found nothing. */
  injection: InjectionScan | null;
};

/** One phrase or trick the prompt-injection filter found, with the original text as evidence. */
export type InjectionFinding = {
  id: string;
  category: string;
  label: string;
  weight: number;
  /** subject, text, html, html-hidden (how), attachment:<name>, decoded:<kind> … */
  where: string;
  excerpt: string;
};

export type InjectionScan = {
  score: number;
  threshold: number;
  /** True when the score reached the threshold and the message was held. */
  flagged: boolean;
  findings: InjectionFinding[];
  /** Parts the filter could not check (an oversize part, a PDF attachment). */
  notChecked?: string[];
  /** Set when the filter itself failed; the message then went on unchecked. */
  error?: string;
  scannedAt: string;
  version: number;
  /** When the owner let a flagged message through. */
  releasedAt?: string;
};

export type OutboxItem = {
  id: string;
  account_id: string;
  session_id: string | null;
  in_reply_to_message_id: string | null;
  to_address: string;
  subject: string | null;
  text: string;
  action: 'reply' | 'escalate';
  status: OutboxStatus;
  status_detail: string | null;
  external_id: string | null;
  created_by: 'agent' | 'user';
  created_at: string;
  sent_at: string | null;
  /** Set for messages a long-running agent task sent. */
  task_id?: number | null;
};

export type ChannelsSummary = {
  unmatched: number;
  /** Messages a rule holds until the owner hands them to the agent. */
  held?: number;
  queued: number;
  failed: number;
  drafts: number;
  /** Accounts and rules agents proposed that wait for an admin's approval. */
  proposals: number;
  enabled: boolean;
};

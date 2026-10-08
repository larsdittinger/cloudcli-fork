import { senderFailedAuth } from '@/modules/channels/sender-auth.js';
import { normalizeAddress } from '@/modules/channels/thread-key.js';
import { parseJson } from '@/modules/channels/types.js';
import type {
  ChannelAccountRow,
  ChannelProposal,
  ChannelRuleRow,
  InboundMessage,
  RuleConditions,
  RuleInput,
} from '@/modules/channels/types.js';
import { AppError } from '@/shared/utils.js';

const PERMISSION_MODES = new Set(['default', 'bypassPermissions', 'acceptEdits', 'plan']);
const CONVERSATION_MODES = new Set(['thread', 'sender', 'new']);
const REPLY_MODES = new Set(['none', 'draft', 'auto']);
const REPLY_SCOPES = new Set(['sender', 'anyone']);

export function parseConditions(raw: string | null | undefined): RuleConditions {
  const parsed = parseJson<RuleConditions>(raw, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * `@firma.cz` matches every address at that domain, `*` matches everything,
 * `+420*` is a glob, anything else must equal the sender exactly.
 */
export function senderMatches(pattern: string, message: InboundMessage): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  if (trimmed === '*') return true;
  const sender = normalizeAddress(message.from.address);
  if (trimmed.startsWith('@')) {
    return sender.endsWith(trimmed.toLowerCase());
  }
  if (trimmed.includes('*') || trimmed.includes('?')) {
    return globToRegExp(normalizeAddress(trimmed) || trimmed).test(sender) || globToRegExp(trimmed).test(sender);
  }
  return normalizeAddress(trimmed) === sender;
}

function containsAny(haystack: string | undefined, needles: string[] | undefined): boolean {
  if (!needles || needles.length === 0) return true;
  const lower = (haystack ?? '').toLowerCase();
  return needles.some((needle) => needle.trim() && lower.includes(needle.trim().toLowerCase()));
}

function regexMatches(haystack: string | undefined, pattern: string | undefined): boolean {
  if (!pattern) return true;
  try {
    return new RegExp(pattern, 'i').test(haystack ?? '');
  } catch {
    return false;
  }
}

export function conditionsMatch(conditions: RuleConditions, message: InboundMessage): boolean {
  if (conditions.excludeSenders?.some((pattern) => senderMatches(pattern, message))) return false;
  if (conditions.senders && conditions.senders.length > 0 && !conditions.senders.some((pattern) => senderMatches(pattern, message))) {
    return false;
  }
  // A forged From must not pass for a trusted sender; open rules (`*`) still see the message.
  if (!isOpenRule(conditions) && senderFailedAuth(message.raw)) return false;
  if (!containsAny(message.subject, conditions.subject?.contains)) return false;
  if (!regexMatches(message.subject, conditions.subject?.regex)) return false;
  if (!containsAny(message.text, conditions.text?.contains)) return false;
  if (!regexMatches(message.text, conditions.text?.regex)) return false;
  if (typeof conditions.isGroup === 'boolean' && conditions.isGroup !== message.isGroup) return false;
  if (typeof conditions.hasAttachments === 'boolean' && conditions.hasAttachments !== message.attachments.length > 0) return false;
  if (conditions.mentionsMe === true && message.raw.mentionsMe !== true) return false;
  return true;
}

export function ruleMatches(rule: ChannelRuleRow, message: InboundMessage, account: ChannelAccountRow): boolean {
  if (rule.enabled !== 1) return false;
  if (rule.account_id && rule.account_id !== account.id) return false;
  if (!rule.account_id && rule.channel && rule.channel !== account.type) return false;
  return conditionsMatch(parseConditions(rule.conditions), message);
}

/** First matching rule in `position` order wins. */
export function findMatchingRule(rules: ChannelRuleRow[], message: InboundMessage, account: ChannelAccountRow): ChannelRuleRow | null {
  const ordered = [...rules].sort((a, b) => a.position - b.position);
  return ordered.find((rule) => ruleMatches(rule, message, account)) ?? null;
}

/** A rule with no sender filter is open to the world; it may not run autonomously or reply on its own. */
export function isOpenRule(conditions: RuleConditions): boolean {
  const senders = (conditions.senders ?? []).map((value) => value.trim()).filter(Boolean);
  return senders.length === 0 || senders.includes('*');
}

/**
 * Used by rule validation and the outbox: the account's "reply automatically
 * to anyone" switch, the owner's explicit choice to let an open rule (no sender
 * filter) send replies without approval.
 */
export function accountAllowsOpenAutoReply(account: ChannelAccountRow | null | undefined): boolean {
  return Boolean(account) && parseJson<Record<string, unknown>>(account?.config ?? '{}', {}).autoReplyAnyone === true;
}

/** Used by the outbox: replies to these senders go out without approval even when the rule drafts. */
export function senderTrustedForAutoReply(rule: ChannelRuleRow, message: InboundMessage): boolean {
  if (senderFailedAuth(message.raw)) return false;
  const patterns = parseJson<string[]>(rule.auto_reply_senders, []);
  return patterns.some((pattern) => pattern.trim() !== '*' && senderMatches(pattern, message));
}

/** `account` is the rule's own account (null for rules over every account or a whole channel type). */
export function validateRuleInput(input: RuleInput, account: ChannelAccountRow | null = null): void {
  const fail = (message: string, code: string) => {
    throw new AppError(message, { code, statusCode: 400 });
  };
  if (typeof input.name !== 'string' || !input.name.trim()) fail('A rule needs a name.', 'RULE_NAME_REQUIRED');
  if (typeof input.projectPath !== 'string' || !input.projectPath.trim()) fail('A rule needs a project.', 'RULE_PROJECT_REQUIRED');
  if (typeof input.provider !== 'string' || !input.provider.trim()) fail('A rule needs a provider.', 'RULE_PROVIDER_REQUIRED');
  if (input.permissionMode && !PERMISSION_MODES.has(input.permissionMode)) fail('Unknown permission mode.', 'RULE_INVALID_PERMISSION_MODE');
  if (input.conversation && !CONVERSATION_MODES.has(input.conversation)) fail('Unknown conversation mode.', 'RULE_INVALID_CONVERSATION');
  if (input.replyMode && !REPLY_MODES.has(input.replyMode)) fail('Unknown reply mode.', 'RULE_INVALID_REPLY_MODE');
  if (input.replyScope && !REPLY_SCOPES.has(input.replyScope)) fail('Unknown reply scope.', 'RULE_INVALID_REPLY_SCOPE');

  const conditions = input.conditions ?? {};
  for (const pattern of [conditions.subject?.regex, conditions.text?.regex]) {
    if (!pattern) continue;
    try {
      new RegExp(pattern, 'i');
    } catch {
      fail(`Invalid regular expression: ${pattern}`, 'RULE_INVALID_REGEX');
    }
  }

  if (!isOpenRule(conditions)) return;
  // Open to anyone who can reach the mailbox or number: a stranger's message must not drive an agent without prompts.
  if (input.permissionMode && input.permissionMode !== 'default') {
    fail(
      'A rule without a sender filter may not bypass permissions: anyone who writes in would steer the agent. Add the senders you trust, or keep the default permission mode.',
      'RULE_OPEN_AUTONOMY',
    );
  }
  // Automatic replies to anyone are the account owner's explicit choice, made on the account.
  if (input.replyMode === 'auto' && !accountAllowsOpenAutoReply(account)) {
    fail(
      'A rule without a sender filter replies automatically only on an account with "Reply automatically to anyone" switched on (Settings → Channels → the account). Or keep drafts and list the senders to answer right away.',
      'RULE_OPEN_AUTONOMY',
    );
  }
}

/** The API shape of a rule, shared by the settings routes and the agents' MCP info. */
export function publicRule(row: ChannelRuleRow) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    position: row.position,
    accountId: row.account_id,
    channel: row.channel,
    conditions: parseConditions(row.conditions),
    projectPath: row.project_path,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    permissionMode: row.permission_mode,
    promptTemplate: row.prompt_template,
    conversation: row.conversation,
    replyMode: row.reply_mode,
    replyScope: row.reply_scope,
    autoReplySenders: parseJson<string[]>(row.auto_reply_senders, []),
    holdInbound: row.hold_inbound === 1,
    ownerUserId: row.owner_user_id,
    proposal: parseJson<ChannelProposal | null>(row.proposal, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

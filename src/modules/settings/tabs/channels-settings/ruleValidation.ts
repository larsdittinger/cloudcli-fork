import type { PermissionMode, ReplyMode, RuleConditions } from '@/modules/channels';

/**
 * Mirrors the server rule: without a sender filter a rule is open to anyone
 * who can reach the mailbox or number, so it may not run without permission
 * prompts or reply on its own.
 */
export function ruleOpenAutonomyError(rule: {
  conditions: RuleConditions;
  permissionMode: PermissionMode;
  replyMode: ReplyMode;
}): string | null {
  const senders = (rule.conditions.senders ?? []).map((value) => value.trim()).filter(Boolean);
  const open = senders.length === 0 || senders.includes('*');
  const autonomous = rule.permissionMode !== 'default' || rule.replyMode === 'auto';
  if (open && autonomous) {
    return 'A rule without a sender filter may not bypass permissions or reply automatically. List the senders you trust, or keep the default permission mode and draft replies.';
  }
  return null;
}

/** "one per line" textareas → clean string arrays. */
export function parseLines(value: string): string[] {
  return value.split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean);
}

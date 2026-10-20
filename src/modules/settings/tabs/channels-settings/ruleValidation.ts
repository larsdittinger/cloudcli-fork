import { i18n } from '@/modules/i18n';
import type { PermissionMode, ReplyMode, RuleConditions } from '@/modules/channels';

/**
 * Mirrors the server rule: without a sender filter a rule is open to anyone
 * who can reach the mailbox or number, so it may not run without permission
 * prompts, and it replies on its own only on an account whose owner switched
 * on "Reply automatically to anyone" (`accountAllowsAutoReply`). An isolated project
 * (`projectIsolated`) runs in a sandbox, so its open rules may use any permission mode.
 */
export function ruleOpenAutonomyError(rule: {
  conditions: RuleConditions;
  permissionMode: PermissionMode;
  replyMode: ReplyMode;
}, accountAllowsAutoReply = false, projectIsolated = false): string | null {
  const senders = (rule.conditions.senders ?? []).map((value) => value.trim()).filter(Boolean);
  const open = senders.length === 0 || senders.includes('*');
  if (!open) return null;
  // In an isolated project the sandbox is the boundary, so any permission mode is fine (the server agrees).
  if (rule.permissionMode !== 'default' && !projectIsolated) {
    return i18n.t('channels:validation.openPermission');
  }
  if (rule.replyMode === 'auto' && !accountAllowsAutoReply) {
    return i18n.t('channels:validation.openAutoReply');
  }
  return null;
}

/** "one per line" textareas → clean string arrays. */
export function parseLines(value: string): string[] {
  return value.split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean);
}

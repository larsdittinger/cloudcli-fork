import path from 'node:path';

import { channelsService, MCP_SERVER_NAME, toPublicAccount } from '@/modules/channels/channels.service.js';
import type { PublicAccount } from '@/modules/channels/channels.service.js';
import { broadcastProposalsUpdated } from '@/modules/channels/channels-broadcast.js';
import { publicRule, validateRuleInput } from '@/modules/channels/rules.service.js';
import type { ChannelProposal, ChannelRuleRow, RuleInput } from '@/modules/channels/types.js';
import { channelAccountsDb, channelMessagesDb, channelRulesDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

/**
 * Agents configure Channels only by proposing: everything they create is
 * stored disabled with a `proposal` record and does nothing until an admin
 * approves it in Settings → Channels. Agents never edit or delete approved
 * configuration — the MCP token is shared by every agent on the instance,
 * including ones started by a stranger's message.
 */

/** Long prompts make links that some mail clients wrap or truncate. */
export const PROMPT_LINK_MAX_CHARS = 4000;

function makeProposal(note: unknown, projectPath: string | null): ChannelProposal {
  return {
    note: typeof note === 'string' ? note.trim().slice(0, 2000) : '',
    projectPath,
    createdAt: new Date().toISOString(),
  };
}

function absoluteOrNull(value: unknown): string | null {
  return typeof value === 'string' && path.isAbsolute(value.trim()) ? path.resolve(value.trim()) : null;
}

function webhookUrl(account: PublicAccount): string | null {
  const base = channelsService.getPublicUrl();
  return account.webhookUrlPath ? `${base ?? ''}${account.webhookUrlPath}` : null;
}

/** Used by the MCP routes: the agent-side half of Channels setup and prompt links. */
export const proposalsService = {
  async proposeAccount(input: {
    type: unknown;
    label: unknown;
    config?: unknown;
    secrets?: unknown;
    agentSend?: unknown;
    note?: unknown;
    cwd?: unknown;
  }) {
    const account = await channelsService.createAccount({
      type: input.type,
      label: input.label,
      config: input.config,
      secrets: input.secrets,
      agentSend: input.agentSend,
      proposal: makeProposal(input.note, absoluteOrNull(input.cwd)),
    });
    broadcastProposalsUpdated({ proposalId: account.id });
    return {
      account: { ...account, secretsOnce: undefined },
      webhookUrl: webhookUrl(account),
      webhookToken: account.secretsOnce?.token ?? null,
      note: 'Proposal saved DISABLED. Tell the user to approve it in Settings → Channels (account card → Approve). '
        + (account.type === 'webhook'
          ? 'The token is shown only now — hand it to whoever configures the calling application and never put it into chat logs or repositories.'
          : account.type === 'whatsapp'
            ? 'After approval the account needs pairing: call channels_whatsapp_pairing_code with the phone number, or let the user scan the QR in Settings.'
            : account.hasSecrets ? '' : 'No password was given — the user fills it in when editing the account before approval.'),
    };
  },

  proposeRule(input: Omit<RuleInput, 'enabled' | 'ownerUserId'> & { note?: unknown; cwd?: unknown }) {
    const projectPath = absoluteOrNull(input.projectPath) ?? absoluteOrNull(input.cwd);
    if (!projectPath) {
      throw new AppError('project_path must be an absolute path (it defaults to your working directory).', { code: 'RULE_PROJECT_REQUIRED', statusCode: 400 });
    }
    if (input.accountId && !channelAccountsDb.get(input.accountId)) {
      throw new AppError('Channel account not found.', { code: 'CHANNEL_ACCOUNT_NOT_FOUND', statusCode: 404 });
    }
    const ruleInput: RuleInput = { ...input, projectPath, enabled: false, ownerUserId: null };
    validateRuleInput(ruleInput);
    const row = channelRulesDb.create(ruleInput, makeProposal(input.note, absoluteOrNull(input.cwd)));
    broadcastProposalsUpdated({ proposalId: row.id });
    return {
      rule: publicRule(row),
      note: 'Proposal saved DISABLED at the end of the rule list (first matching rule wins). Tell the user to approve it in Settings → Channels (rule → Approve).',
    };
  },

  /** Removes an agent's own pending proposal; approved configuration is off limits. */
  async withdrawProposal(kind: unknown, id: string): Promise<{ withdrawn: true }> {
    if (kind === 'account') {
      const row = channelAccountsDb.get(id);
      if (!row) throw new AppError('Channel account not found.', { code: 'CHANNEL_ACCOUNT_NOT_FOUND', statusCode: 404 });
      if (!row.proposal) throw new AppError('Only pending proposals can be withdrawn; approved accounts are managed by the user.', { code: 'CHANNEL_NOT_PROPOSAL', statusCode: 403 });
      await channelsService.deleteAccount(id);
    } else if (kind === 'rule') {
      const row = channelRulesDb.get(id);
      if (!row) throw new AppError('Rule not found.', { code: 'RULE_NOT_FOUND', statusCode: 404 });
      if (!row.proposal) throw new AppError('Only pending proposals can be withdrawn; approved rules are managed by the user.', { code: 'RULE_NOT_PROPOSAL', statusCode: 403 });
      channelRulesDb.delete(id);
    } else {
      throw new AppError('kind must be "account" or "rule".', { code: 'INVALID_REQUEST', statusCode: 400 });
    }
    broadcastProposalsUpdated({ proposalId: id });
    return { withdrawn: true };
  },

  /** Admin approval of a proposed rule (Settings → Channels). */
  approveRule(id: string): ChannelRuleRow {
    const rule = channelRulesDb.get(id);
    if (!rule) throw new AppError('Rule not found.', { code: 'RULE_NOT_FOUND', statusCode: 404 });
    if (!rule.proposal) throw new AppError('This rule is not a pending proposal.', { code: 'RULE_NOT_PROPOSAL', statusCode: 409 });
    return channelRulesDb.approveProposal(id) as ChannelRuleRow;
  },

  async whatsappPairingCode(accountId: string, phone: unknown): Promise<{ pairingCode: string; note: string }> {
    const row = channelAccountsDb.get(accountId);
    if (!row || row.type !== 'whatsapp') throw new AppError('WhatsApp account not found.', { code: 'CHANNEL_ACCOUNT_NOT_FOUND', statusCode: 404 });
    if (row.proposal) throw new AppError('The account is still a proposal — the user has to approve it first.', { code: 'CHANNEL_NOT_APPROVED', statusCode: 409 });
    const pairingCode = await channelsService.requestPairingCode(accountId, phone);
    return {
      pairingCode,
      note: 'On the phone: WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead, then type this code. It expires within minutes.',
    };
  },

  /**
   * A link that opens CloudCLI with `prompt` prefilled in the composer — never
   * sent automatically. A message id resolves to the chat it started, so the
   * prompt continues that history; otherwise the link opens a new chat in the project.
   */
  buildPromptLink(input: { prompt: string; messageId?: string; sessionId?: string; projectPath?: string; cwd?: unknown }) {
    const prompt = input.prompt.trim();
    if (!prompt) throw new AppError('prompt is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
    if (prompt.length > PROMPT_LINK_MAX_CHARS) {
      throw new AppError(`prompt is too long for a link (max ${PROMPT_LINK_MAX_CHARS} characters).`, { code: 'PROMPT_TOO_LONG', statusCode: 400 });
    }
    let sessionId = input.sessionId?.trim() || null;
    let projectPath = absoluteOrNull(input.projectPath);
    if (input.messageId) {
      const message = channelMessagesDb.get(input.messageId);
      if (!message) throw new AppError('Message not found.', { code: 'CHANNEL_MESSAGE_NOT_FOUND', statusCode: 404 });
      sessionId = message.session_id;
      if (!sessionId && message.rule_id) projectPath = projectPath ?? channelRulesDb.get(message.rule_id)?.project_path ?? null;
    }
    projectPath = projectPath ?? absoluteOrNull(input.cwd);
    if (!sessionId && !projectPath) {
      throw new AppError('Give message_id, session_id or project_path.', { code: 'INVALID_REQUEST', statusCode: 400 });
    }

    const base = channelsService.getPublicUrl();
    const query = new URLSearchParams();
    if (!sessionId && projectPath) query.set('project', projectPath);
    query.set('prompt', prompt);
    const pathPart = sessionId ? `/session/${encodeURIComponent(sessionId)}` : '/';
    return {
      url: `${base ?? ''}${pathPart}?${query.toString()}`,
      opens: sessionId ? 'existing chat (continues its history)' : 'new chat in the project',
      sessionId,
      projectPath: sessionId ? null : projectPath,
      note: base
        ? 'The prompt is only prefilled; the user reviews and sends it.'
        : 'The public URL of this instance is unknown yet (set CLOUDCLI_PUBLIC_URL or have the admin open Settings → Channels once) — the link is relative.',
    };
  },

  /** Live state for `channels_get_info`; secrets never leave the server. */
  getState(cwd: unknown) {
    return {
      channelsEnabled: channelsService.isEnabled(),
      mcpServer: MCP_SERVER_NAME,
      publicUrl: channelsService.getPublicUrl(),
      yourWorkingDirectory: absoluteOrNull(cwd),
      accounts: channelAccountsDb.list().map((row) => {
        const account = toPublicAccount(row);
        return {
          id: account.id,
          type: account.type,
          label: account.label,
          enabled: account.enabled,
          status: account.status,
          statusDetail: account.statusDetail,
          agentSend: account.agentSend,
          config: account.config,
          hasSecrets: account.hasSecrets,
          webhookUrl: webhookUrl(account),
          proposal: account.proposal,
        };
      }),
      rules: channelRulesDb.listOrdered().map(publicRule),
    };
  },
};

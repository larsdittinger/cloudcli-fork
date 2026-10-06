import express from 'express';

import { buildAgentGuide } from '@/modules/channels/agent-info.js';
import { channelsService } from '@/modules/channels/channels.service.js';
import { outboxService } from '@/modules/channels/outbox.service.js';
import { proposalsService } from '@/modules/channels/proposals.service.js';
import { parseJson } from '@/modules/channels/types.js';
import type { ChannelMessageRow, ChannelType, InboundAttachment, RuleInput } from '@/modules/channels/types.js';
import { channelAccountsDb, channelMessagesDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

const router = express.Router();

function readBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S.*)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function readString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(`${name} is required.`, { code: 'INVALID_REQUEST', statusCode: 400 });
  }
  return value.trim();
}

function readOptional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readObject<T>(value: unknown): T | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as T : undefined;
}

function messageForAgent(row: ChannelMessageRow, full: boolean) {
  const attachments = parseJson<InboundAttachment[]>(row.attachments_json, []);
  const raw = parseJson<Record<string, unknown>>(row.raw_json, {});
  return {
    id: row.id,
    accountId: row.account_id,
    channel: row.channel,
    threadKey: row.thread_key,
    metadata: full && row.channel === 'webhook' ? raw.metadata ?? null : undefined,
    from: row.from_address,
    fromName: row.from_name,
    to: parseJson<string[]>(row.to_json, []),
    subject: row.subject,
    text: full ? row.text : row.text.slice(0, 2000),
    isGroup: row.is_group === 1,
    attachments: attachments.map((attachment) => ({ name: attachment.name, mime: attachment.mime, size: attachment.size, path: attachment.path })),
    receivedAt: row.received_at,
    status: row.status,
    sessionId: row.session_id,
    ...(full ? { headers: { messageId: raw.messageId ?? null, inReplyTo: raw.inReplyTo ?? null, replyTo: raw.replyTo ?? null, quotedText: raw.quotedText ?? null } } : {}),
  };
}

router.use((req, res, next) => {
  const expected = channelsService.getMcpToken();
  const token = readBearerToken(req.headers.authorization) || String(req.headers['x-channels-mcp-token'] || '');
  if (!token || token !== expected) {
    res.status(401).json({ success: false, error: 'Invalid Channels MCP token.' });
    return;
  }
  next();
});

router.post('/tools/:toolName', async (req, res) => {
  try {
    const input = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    let result: unknown;

    switch (req.params.toolName) {
      case 'channels_reply': {
        const row = await outboxService.createReply({
          messageId: readString(input.message_id, 'message_id'),
          text: readString(input.text, 'text'),
          action: input.action as 'reply' | 'escalate' | undefined,
          createdBy: 'agent',
        });
        result = {
          outboxId: row.id,
          action: row.action,
          status: row.status,
          deliveredNow: row.status === 'sent',
          note: row.status === 'draft'
            ? 'The reply is waiting for the user to approve it in CloudCLI. Do not send it again.'
            : row.status === 'sent'
              ? (row.action === 'escalate' ? 'The internal handoff was published for the application to notify a human. It is not a customer reply.' : 'The reply was sent or published for polling.')
              : `Sending failed: ${row.status_detail ?? 'unknown error'}.`,
        };
        break;
      }
      case 'channels_send_message': {
        const row = await outboxService.createSend({
          accountId: readString(input.account_id, 'account_id'),
          to: readString(input.to, 'to'),
          text: readString(input.text, 'text'),
          subject: typeof input.subject === 'string' ? input.subject : null,
          createdBy: 'agent',
        });
        result = {
          outboxId: row.id,
          status: row.status,
          deliveredNow: row.status === 'sent',
          note: row.status === 'draft'
            ? 'The message is waiting for the user to approve it in CloudCLI. Do not send it again.'
            : row.status === 'sent'
              ? 'The message was sent.'
              : `Sending failed: ${row.status_detail ?? 'unknown error'}.`,
        };
        break;
      }
      case 'channels_get_message': {
        const row = channelMessagesDb.get(readString(input.message_id, 'message_id'));
        if (!row) throw new AppError('Message not found.', { code: 'CHANNEL_MESSAGE_NOT_FOUND', statusCode: 404 });
        result = messageForAgent(row, true);
        break;
      }
      case 'channels_list_messages': {
        const limit = typeof input.limit === 'number' ? Math.min(Math.max(Math.floor(input.limit), 1), 100) : 20;
        const accountId = typeof input.account_id === 'string' && input.account_id ? input.account_id : undefined;
        const threadKey = typeof input.thread_key === 'string' && input.thread_key ? input.thread_key : undefined;
        const rows = threadKey && accountId
          ? channelMessagesDb.listByThread(accountId, threadKey, limit)
          : channelMessagesDb.list({ accountId, limit });
        result = rows.map((row) => messageForAgent(row, false));
        break;
      }
      case 'channels_list_accounts': {
        result = channelAccountsDb.list().map((account) => ({
          id: account.id,
          type: account.type,
          label: account.label,
          status: account.status,
          agentSend: account.agent_send,
          pendingApproval: account.proposal !== null,
        }));
        break;
      }
      case 'channels_get_info': {
        const state = proposalsService.getState(input.cwd);
        result = {
          guide: buildAgentGuide({ channelsEnabled: state.channelsEnabled, publicUrl: state.publicUrl, cwd: state.yourWorkingDirectory }),
          state,
        };
        break;
      }
      case 'channels_propose_account': {
        result = await proposalsService.proposeAccount({
          type: input.type,
          label: input.label,
          config: input.config,
          secrets: input.secrets,
          agentSend: input.agent_send,
          note: input.note,
          cwd: input.cwd,
        });
        break;
      }
      case 'channels_propose_rule': {
        const rule: Omit<RuleInput, 'enabled' | 'ownerUserId'> = {
          name: readString(input.name, 'name'),
          accountId: readOptional(input.account_id) ?? null,
          channel: (readOptional(input.channel) as ChannelType | undefined) ?? null,
          conditions: readObject<RuleInput['conditions']>(input.conditions) ?? {},
          projectPath: readOptional(input.project_path) ?? '',
          provider: readOptional(input.provider) ?? 'claude',
          model: readOptional(input.model) ?? null,
          effort: readOptional(input.effort) ?? null,
          permissionMode: (readOptional(input.permission_mode) as RuleInput['permissionMode']) ?? 'default',
          promptTemplate: typeof input.prompt_template === 'string' ? input.prompt_template : '',
          conversation: (readOptional(input.conversation) as RuleInput['conversation']) ?? 'thread',
          replyMode: (readOptional(input.reply_mode) as RuleInput['replyMode']) ?? 'none',
          replyScope: (readOptional(input.reply_scope) as RuleInput['replyScope']) ?? 'sender',
        };
        result = proposalsService.proposeRule({ ...rule, note: input.note, cwd: input.cwd });
        break;
      }
      case 'channels_withdraw_proposal': {
        result = await proposalsService.withdrawProposal(input.kind, readString(input.id, 'id'));
        break;
      }
      case 'channels_whatsapp_pairing_code': {
        result = await proposalsService.whatsappPairingCode(readString(input.account_id, 'account_id'), input.phone);
        break;
      }
      case 'channels_build_link': {
        result = proposalsService.buildPromptLink({
          prompt: readString(input.prompt, 'prompt'),
          messageId: readOptional(input.message_id),
          sessionId: readOptional(input.session_id),
          projectPath: readOptional(input.project_path),
          cwd: input.cwd,
        });
        break;
      }
      default:
        throw new AppError(`Unknown tool: ${req.params.toolName}`, { code: 'UNKNOWN_TOOL', statusCode: 404 });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    const status = error instanceof AppError ? error.statusCode : 500;
    res.status(status).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;

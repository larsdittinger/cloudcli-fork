import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import type { Request, Response } from 'express';

import { channelsService, CHANNELS_ROOT, MCP_SERVER_NAME } from '@/modules/channels/channels.service.js';
import { dispatchMessage, rowToInboundMessage } from '@/modules/channels/dispatcher.service.js';
import { outboxService } from '@/modules/channels/outbox.service.js';
import { parseConditions, ruleMatches, validateRuleInput } from '@/modules/channels/rules.service.js';
import { parseJson } from '@/modules/channels/types.js';
import type { ChannelMessageRow, ChannelRuleRow, InboundAttachment, MessageStatus, OutboxStatus, RuleInput } from '@/modules/channels/types.js';
import { channelAccountsDb, channelMessagesDb, channelRulesDb } from '@/modules/database/index.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

function readParam(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(`${field} is required.`, { code: 'INVALID_REQUEST', statusCode: 400 });
  }
  return value;
}

function readUserId(request: Request): number | null {
  const userId = Number((request as AuthenticatedRequest).user?.id);
  return Number.isInteger(userId) ? userId : null;
}

function publicRule(row: ChannelRuleRow) {
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
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicMessage(row: ChannelMessageRow, ruleNames: Map<string, string>, accountLabels: Map<string, string>) {
  return {
    id: row.id,
    accountId: row.account_id,
    accountLabel: accountLabels.get(row.account_id) ?? null,
    channel: row.channel,
    externalId: row.external_id,
    threadKey: row.thread_key,
    from: { address: row.from_address, name: row.from_name },
    to: parseJson<string[]>(row.to_json, []),
    subject: row.subject,
    text: row.text,
    html: row.html,
    isGroup: row.is_group === 1,
    attachments: parseJson<InboundAttachment[]>(row.attachments_json, []).map((attachment, index) => ({
      name: attachment.name,
      mime: attachment.mime,
      size: attachment.size,
      index,
    })),
    receivedAt: row.received_at,
    ruleId: row.rule_id,
    ruleName: row.rule_id ? ruleNames.get(row.rule_id) ?? null : null,
    sessionId: row.session_id,
    status: row.status,
    statusDetail: row.status_detail,
  };
}

function lookups() {
  return {
    ruleNames: new Map(channelRulesDb.listOrdered().map((rule) => [rule.id, rule.name])),
    accountLabels: new Map(channelAccountsDb.list().map((account) => [account.id, account.label])),
  };
}

function readRuleInput(body: Record<string, unknown>, userId: number | null): RuleInput {
  return {
    name: String(body.name ?? ''),
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    accountId: typeof body.accountId === 'string' && body.accountId ? body.accountId : null,
    channel: typeof body.channel === 'string' && body.channel ? (body.channel as RuleInput['channel']) : null,
    conditions: body.conditions && typeof body.conditions === 'object' ? (body.conditions as RuleInput['conditions']) : {},
    projectPath: String(body.projectPath ?? ''),
    provider: String(body.provider ?? 'claude'),
    model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null,
    effort: typeof body.effort === 'string' && body.effort.trim() ? body.effort.trim() : null,
    permissionMode: (body.permissionMode as RuleInput['permissionMode']) ?? 'default',
    promptTemplate: typeof body.promptTemplate === 'string' ? body.promptTemplate : '',
    conversation: (body.conversation as RuleInput['conversation']) ?? 'thread',
    replyMode: (body.replyMode as RuleInput['replyMode']) ?? 'none',
    replyScope: (body.replyScope as RuleInput['replyScope']) ?? 'sender',
    ownerUserId: userId,
  };
}

const MESSAGE_STATUSES: MessageStatus[] = ['unmatched', 'ignored', 'queued', 'dispatched', 'failed', 'manual'];
const OUTBOX_STATUSES: OutboxStatus[] = ['draft', 'approved', 'sending', 'sent', 'failed', 'discarded'];

const router = express.Router();

// --- settings ---------------------------------------------------------------

router.get('/settings', asyncHandler(async (_req: Request, res: Response) => {
  res.json(createApiSuccessResponse({
    enabled: channelsService.isEnabled(),
    mcpServerName: MCP_SERVER_NAME,
    accounts: channelsService.listAccounts().length,
    rules: channelRulesDb.listOrdered().length,
  }));
}));

router.put('/settings', asyncHandler(async (req: Request, res: Response) => {
  const enabled = (req.body ?? {}).enabled;
  if (typeof enabled !== 'boolean') {
    throw new AppError('"enabled" must be a boolean.', { code: 'INVALID_REQUEST', statusCode: 400 });
  }
  res.json(createApiSuccessResponse(await channelsService.setEnabled(enabled)));
}));

router.get('/summary', asyncHandler(async (_req: Request, res: Response) => {
  const counts = channelMessagesDb.countByStatus();
  res.json(createApiSuccessResponse({
    unmatched: counts.unmatched,
    queued: counts.queued,
    failed: counts.failed,
    drafts: outboxService.countDrafts(),
    enabled: channelsService.isEnabled(),
  }));
}));

// --- accounts ---------------------------------------------------------------

router.get('/accounts', asyncHandler(async (_req: Request, res: Response) => {
  res.json(createApiSuccessResponse(channelsService.listAccounts()));
}));

router.post('/accounts', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  res.status(201).json(createApiSuccessResponse(await channelsService.createAccount({
    type: body.type, label: body.label, config: body.config, secrets: body.secrets, agentSend: body.agentSend,
  })));
}));

router.put('/accounts/:id', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  res.json(createApiSuccessResponse(await channelsService.updateAccount(readParam(req.params.id, 'id'), {
    label: body.label, enabled: body.enabled, config: body.config, secrets: body.secrets, agentSend: body.agentSend,
  })));
}));

router.delete('/accounts/:id', asyncHandler(async (req: Request, res: Response) => {
  await channelsService.deleteAccount(readParam(req.params.id, 'id'));
  res.json(createApiSuccessResponse({ deleted: true }));
}));

router.post('/accounts/:id/test', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(await channelsService.testAccount(readParam(req.params.id, 'id'))));
}));

router.post('/accounts/:id/reconnect', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(await channelsService.reconnectAccount(readParam(req.params.id, 'id'))));
}));

router.get('/accounts/:id/pairing', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(channelsService.getPairing(readParam(req.params.id, 'id'))));
}));

router.post('/accounts/:id/pairing-code', asyncHandler(async (req: Request, res: Response) => {
  const code = await channelsService.requestPairingCode(readParam(req.params.id, 'id'), (req.body ?? {}).phoneNumber);
  res.json(createApiSuccessResponse({ pairingCode: code }));
}));

// --- rules ------------------------------------------------------------------

router.get('/rules', asyncHandler(async (_req: Request, res: Response) => {
  res.json(createApiSuccessResponse(channelRulesDb.listOrdered().map(publicRule)));
}));

router.post('/rules', asyncHandler(async (req: Request, res: Response) => {
  const input = readRuleInput((req.body ?? {}) as Record<string, unknown>, readUserId(req));
  validateRuleInput(input);
  res.status(201).json(createApiSuccessResponse(publicRule(channelRulesDb.create(input))));
}));

router.put('/rules/order', asyncHandler(async (req: Request, res: Response) => {
  const ids = (req.body ?? {}).ids;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
    throw new AppError('"ids" must be an array of rule ids.', { code: 'INVALID_REQUEST', statusCode: 400 });
  }
  channelRulesDb.reorder(ids as string[]);
  res.json(createApiSuccessResponse(channelRulesDb.listOrdered().map(publicRule)));
}));

router.put('/rules/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = readParam(req.params.id, 'id');
  const current = channelRulesDb.get(id);
  if (!current) {
    throw new AppError('Rule not found.', { code: 'RULE_NOT_FOUND', statusCode: 404 });
  }
  const input = readRuleInput((req.body ?? {}) as Record<string, unknown>, current.owner_user_id);
  validateRuleInput(input);
  res.json(createApiSuccessResponse(publicRule(channelRulesDb.update(id, input) as ChannelRuleRow)));
}));

router.delete('/rules/:id', asyncHandler(async (req: Request, res: Response) => {
  if (!channelRulesDb.delete(readParam(req.params.id, 'id'))) {
    throw new AppError('Rule not found.', { code: 'RULE_NOT_FOUND', statusCode: 404 });
  }
  res.json(createApiSuccessResponse({ deleted: true }));
}));

/** Dry run against recent messages so a rule can be checked before it fires. */
router.post('/rules/:id/test', asyncHandler(async (req: Request, res: Response) => {
  const rule = channelRulesDb.get(readParam(req.params.id, 'id'));
  if (!rule) {
    throw new AppError('Rule not found.', { code: 'RULE_NOT_FOUND', statusCode: 404 });
  }
  const accounts = new Map(channelAccountsDb.list().map((account) => [account.id, account]));
  const testable = { ...rule, enabled: 1 };
  const matches = channelMessagesDb.list({ limit: 50 }).map((row) => {
    const account = accounts.get(row.account_id);
    return {
      messageId: row.id,
      from: row.from_address,
      subject: row.subject,
      receivedAt: row.received_at,
      matched: account ? ruleMatches(testable, rowToInboundMessage(row), account) : false,
    };
  });
  res.json(createApiSuccessResponse({ matches }));
}));

// --- messages ---------------------------------------------------------------

router.get('/messages', asyncHandler(async (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' && MESSAGE_STATUSES.includes(req.query.status as MessageStatus)
    ? (req.query.status as MessageStatus)
    : undefined;
  const rows = channelMessagesDb.list({
    accountId: typeof req.query.accountId === 'string' ? req.query.accountId : undefined,
    status,
    limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
    before: typeof req.query.before === 'string' ? req.query.before : undefined,
  });
  const { ruleNames, accountLabels } = lookups();
  res.json(createApiSuccessResponse(rows.map((row) => publicMessage(row, ruleNames, accountLabels))));
}));

router.get('/messages/by-session/:sessionId', asyncHandler(async (req: Request, res: Response) => {
  const row = channelMessagesDb.getBySession(readParam(req.params.sessionId, 'sessionId'));
  if (!row) {
    res.json(createApiSuccessResponse(null));
    return;
  }
  const { ruleNames, accountLabels } = lookups();
  const rule = row.rule_id ? channelRulesDb.get(row.rule_id) : null;
  res.json(createApiSuccessResponse({
    message: publicMessage(row, ruleNames, accountLabels),
    rule: rule ? publicRule(rule) : null,
  }));
}));

router.get('/messages/:id', asyncHandler(async (req: Request, res: Response) => {
  const row = channelMessagesDb.get(readParam(req.params.id, 'id'));
  if (!row) {
    throw new AppError('Message not found.', { code: 'CHANNEL_MESSAGE_NOT_FOUND', statusCode: 404 });
  }
  const { ruleNames, accountLabels } = lookups();
  res.json(createApiSuccessResponse(publicMessage(row, ruleNames, accountLabels)));
}));

router.post('/messages/:id/dispatch', asyncHandler(async (req: Request, res: Response) => {
  const id = readParam(req.params.id, 'id');
  const ruleId = readParam((req.body ?? {}).ruleId, 'ruleId');
  const runtime = channelsService.getRuntime();
  if (!runtime) {
    throw new AppError('The agent runtime is not ready yet.', { code: 'RUNTIME_UNAVAILABLE', statusCode: 503 });
  }
  const result = await dispatchMessage(id, ruleId, runtime, { manual: true });
  if (result.error) {
    throw new AppError(result.error, { code: 'DISPATCH_FAILED', statusCode: 409 });
  }
  res.json(createApiSuccessResponse(result));
}));

router.post('/messages/:id/ignore', asyncHandler(async (req: Request, res: Response) => {
  const id = readParam(req.params.id, 'id');
  if (!channelMessagesDb.get(id)) {
    throw new AppError('Message not found.', { code: 'CHANNEL_MESSAGE_NOT_FOUND', statusCode: 404 });
  }
  channelMessagesDb.setStatus(id, 'ignored', null);
  res.json(createApiSuccessResponse({ ignored: true }));
}));

router.get('/attachments/:messageId/:index', asyncHandler(async (req: Request, res: Response) => {
  const row = channelMessagesDb.get(readParam(req.params.messageId, 'messageId'));
  const index = Number(req.params.index);
  const attachment = row ? parseJson<InboundAttachment[]>(row.attachments_json, [])[index] : undefined;
  if (!row || !attachment) {
    throw new AppError('Attachment not found.', { code: 'ATTACHMENT_NOT_FOUND', statusCode: 404 });
  }
  const resolved = path.resolve(attachment.path);
  const root = path.resolve(CHANNELS_ROOT, 'attachments');
  if (!resolved.startsWith(root + path.sep) || !fs.existsSync(resolved)) {
    throw new AppError('Attachment not found.', { code: 'ATTACHMENT_NOT_FOUND', statusCode: 404 });
  }
  res.setHeader('Content-Type', attachment.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(attachment.name)}"`);
  res.sendFile(resolved);
}));

// --- outbox -----------------------------------------------------------------

router.get('/outbox', asyncHandler(async (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string'
    ? req.query.status.split(',').filter((value): value is OutboxStatus => OUTBOX_STATUSES.includes(value as OutboxStatus))
    : undefined;
  res.json(createApiSuccessResponse(outboxService.list({
    status: status?.length ? status : undefined,
    sessionId: typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined,
    limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
  })));
}));

router.post('/outbox/:id/approve', asyncHandler(async (req: Request, res: Response) => {
  const text = (req.body ?? {}).text;
  res.json(createApiSuccessResponse(await outboxService.approve(readParam(req.params.id, 'id'), { text: typeof text === 'string' ? text : undefined })));
}));

router.post('/outbox/:id/discard', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(outboxService.discard(readParam(req.params.id, 'id'))));
}));

router.post('/outbox/:id/retry', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(await outboxService.retry(readParam(req.params.id, 'id'))));
}));

export default router;

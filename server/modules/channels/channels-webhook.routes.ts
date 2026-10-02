import express from 'express';
import type { Request, Response } from 'express';

import { channelsService } from '@/modules/channels/channels.service.js';
import { parseJson } from '@/modules/channels/types.js';
import { channelMessagesDb, channelOutboxDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

function readToken(req: Request): string {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(\S.*)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  return typeof req.query.token === 'string' ? req.query.token : '';
}

const router = express.Router();

/**
 * Public entry for anything that can POST JSON — n8n, a Telegram bot, a form.
 * Authenticated by the account's own token, not by a user session.
 */
router.post(
  '/:accountId',
  express.json({ limit: '30mb' }),
  asyncHandler(async (req: Request, res: Response) => {
    const stored = await channelsService.ingestWebhook(String(req.params.accountId), readToken(req), req.body);
    res.status(202).json(createApiSuccessResponse({ messageId: stored.id, status: stored.status, sessionId: stored.session_id }));
  }),
);

/** Only this account's message and decisions, never chat transcripts or other accounts. */
router.get('/:accountId/messages/:messageId', asyncHandler(async (req: Request, res: Response) => {
  const accountId = String(req.params.accountId);
  channelsService.authorizeWebhook(accountId, readToken(req));
  const message = channelMessagesDb.get(String(req.params.messageId));
  if (!message || message.account_id !== accountId) {
    throw new AppError('Webhook message not found.', { code: 'WEBHOOK_MESSAGE_NOT_FOUND', statusCode: 404 });
  }
  res.set('Cache-Control', 'no-store');
  res.json(createApiSuccessResponse({
    messageId: message.id,
    externalId: message.external_id,
    thread: message.thread_key,
    metadata: parseJson<Record<string, unknown>>(message.raw_json, {}).metadata ?? null,
    status: message.status,
    statusDetail: message.status_detail,
    sessionId: message.session_id,
    processing: !!message.session_id && chatRunRegistry.isProcessing(message.session_id),
    results: channelOutboxDb.listByMessage(message.id).map((row) => ({
      id: row.id,
      action: row.action,
      text: row.text,
      to: row.to_address,
      status: row.status,
      statusDetail: row.status_detail,
      createdAt: row.created_at,
    })),
  }));
}));

export default router;

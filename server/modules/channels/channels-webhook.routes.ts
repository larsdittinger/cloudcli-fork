import express from 'express';
import type { Request, Response } from 'express';

import { channelsService } from '@/modules/channels/channels.service.js';
import { asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

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

export default router;

import express from 'express';

import { requireAdmin } from '@/modules/auth/index.js';

import type { createSettingsService } from './settings.service.js';

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

function userId(req: express.Request): number {
  return Number((req as AuthenticatedRequest).user?.id);
}

function queryString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Creates thin Settings transport handlers around the application service. */
export function createSettingsRouter(
  service: ReturnType<typeof createSettingsService>,
): express.Router {
  const router = express.Router();
  const respond = (operation: (req: express.Request) => unknown | Promise<unknown>) =>
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try { res.json(await operation(req)); } catch (error) { next(error); }
    };

  // API keys open the external Agent API and credentials hold the GitHub
  // tokens agent runs use: admin-only. Notification and push settings stay
  // per user for everyone.
  router.get('/api-keys', requireAdmin, respond((req) => service.listApiKeys(userId(req))));
  router.post('/api-keys', requireAdmin, respond((req) => service.createApiKey(userId(req), req.body?.keyName)));
  router.delete('/api-keys/:keyId', requireAdmin, respond((req) => service.deleteApiKey(userId(req), Number(req.params.keyId))));
  router.patch('/api-keys/:keyId/toggle', requireAdmin, respond((req) => service.toggleApiKey(
    userId(req), Number(req.params.keyId), req.body?.isActive,
  )));
  router.get('/credentials', requireAdmin, respond((req) => service.listCredentials(
    userId(req), queryString(req.query.type),
  )));
  router.post('/credentials', requireAdmin, respond((req) => service.createCredential(userId(req), req.body ?? {})));
  router.delete('/credentials/:credentialId', requireAdmin, respond((req) => service.deleteCredential(
    userId(req), Number(req.params.credentialId),
  )));
  router.patch('/credentials/:credentialId/toggle', requireAdmin, respond((req) => service.toggleCredential(
    userId(req), Number(req.params.credentialId), req.body?.isActive,
  )));
  router.get('/notification-preferences', respond((req) => service.getNotificationPreferences(userId(req))));
  router.put('/notification-preferences', respond((req) => service.updateNotificationPreferences(
    userId(req), req.body ?? {},
  )));
  router.get('/push/vapid-public-key', respond(() => service.getVapidPublicKey()));
  router.post('/push/subscribe', respond((req) => service.subscribeToPush(userId(req), req.body ?? {})));
  router.post('/push/unsubscribe', respond((req) => service.unsubscribeFromPush(
    userId(req), req.body?.endpoint,
  )));
  return router;
}

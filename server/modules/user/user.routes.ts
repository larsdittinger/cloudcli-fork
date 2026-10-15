import express from 'express';

import { assertSessionAccess } from '@/modules/auth/index.js';

import type { createUserService } from './user.service.js';

type AuthenticatedRequest = express.Request & { user?: { id?: number | string; role?: string } };

function readUserId(request: express.Request): number {
  const rawUserId = (request as AuthenticatedRequest).user?.id;
  return Number(rawUserId);
}

function readUserRole(request: express.Request): string | undefined {
  return (request as AuthenticatedRequest).user?.role;
}

/** Creates thin user routes that parse authenticated input and call the service. */
export function createUserRouter(service: ReturnType<typeof createUserService>): express.Router {
  const router = express.Router();

  router.get('/git-config', async (req, res, next) => {
    try {
      res.json(await service.getGitConfig(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/git-config', async (req, res, next) => {
    try {
      const body = req.body as { gitName?: unknown; gitEmail?: unknown };
      res.json(await service.updateGitConfig(readUserId(req), body.gitName, body.gitEmail));
    } catch (error) {
      next(error);
    }
  });

  router.post('/complete-onboarding', (req, res, next) => {
    try {
      res.json(service.completeOnboarding(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/onboarding-status', (req, res, next) => {
    try {
      res.json(service.getOnboardingStatus(readUserId(req), readUserRole(req)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/preferences', (req, res, next) => {
    try {
      res.json(service.getPreferences(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/preferences', (req, res, next) => {
    try {
      res.json(service.savePreferences(readUserId(req), req.body));
    } catch (error) {
      next(error);
    }
  });

  router.get('/drafts', (req, res, next) => {
    try {
      res.json(service.getDrafts(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  // The scope is a session id or `project:<id>`, so it is read from the body
  // rather than the path: neither form is guaranteed to be URL-path-safe.
  router.put('/drafts', (req, res, next) => {
    try {
      const body = req.body as { scope?: unknown; queuedMessage?: unknown };
      // A queued turn is sent into the chat by the server later, so it is a
      // write: only into a chat the user owns (not one merely shared with them).
      if (body?.queuedMessage != null && typeof body.scope === 'string' && !body.scope.startsWith('project:')) {
        assertSessionAccess((req as AuthenticatedRequest).user, body.scope);
      }
      res.json(service.saveDraft(readUserId(req), body?.scope, req.body));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/drafts', (req, res, next) => {
    try {
      const body = req.body as { scope?: unknown };
      res.json(service.deleteDraft(readUserId(req), body?.scope));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

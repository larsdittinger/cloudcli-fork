import express from 'express';

import type { createAdminService } from './admin.service.js';

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

function readUserId(request: express.Request): number {
  const rawUserId = (request as AuthenticatedRequest).user?.id;
  return Number(rawUserId);
}

/** Creates thin admin routes for user management (mounted behind requireAdmin). */
export function createAdminRouter(service: ReturnType<typeof createAdminService>): express.Router {
  const router = express.Router();

  router.get('/users', (req, res, next) => {
    try {
      res.json(service.listUsers());
    } catch (error) {
      next(error);
    }
  });

  router.post('/users', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.createUser(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/users/:userId', (req, res, next) => {
    try {
      res.json(service.deleteUser(readUserId(req), req.params.userId));
    } catch (error) {
      next(error);
    }
  });

  router.put('/users/:userId/password', async (req, res, next) => {
    try {
      const body = req.body as { password?: unknown };
      res.json(await service.updatePassword(req.params.userId, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.put('/users/:userId/projects', (req, res, next) => {
    try {
      const body = req.body as { projectIds?: unknown };
      res.json(service.setProjects(req.params.userId, body.projectIds));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

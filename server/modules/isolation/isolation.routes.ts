// Admin API of isolated projects: /api/isolation (mounted behind authenticateToken + requireAdmin).
import express, { type Request, type Response } from 'express';

import { requireAdmin } from '@/modules/auth/index.js';
import { AllowlistValidationError, isolationService } from '@/modules/isolation/isolation.service.js';
import { asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

const projectIdOf = (req: Request): string => String(req.params.projectId);

// Also enforced here, not only at the mount: these routes change what a sandbox may reach.
router.use(requireAdmin);

router.get('/status', asyncHandler(async (_req: Request, res: Response) => {
  res.json(createApiSuccessResponse(await isolationService.status()));
}));

router.get('/projects/:projectId', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(isolationService.getProject(projectIdOf(req))));
}));

router.put('/projects/:projectId', asyncHandler(async (req: Request, res: Response) => {
  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { allowlist?: unknown; tools?: unknown };
    res.json(createApiSuccessResponse(await isolationService.updateProject(projectIdOf(req), body)));
  } catch (error) {
    if (error instanceof AllowlistValidationError) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_ALLOWLIST', message: error.message },
        errors: error.errors,
      });
      return;
    }
    throw error;
  }
}));

router.get('/projects/:projectId/blocked', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(await isolationService.blocked(projectIdOf(req))));
}));

router.post('/projects/:projectId/self-check', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(await isolationService.selfCheck(projectIdOf(req))));
}));

export default router;

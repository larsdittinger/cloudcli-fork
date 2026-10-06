import express from 'express';
import type { Request, Response } from 'express';

import { schedulesService } from '@/modules/schedules/schedules.service.js';
import type { ScheduleInput } from '@/modules/schedules/schedules.service.js';
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

function readQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readInput(body: unknown): ScheduleInput {
  return (body && typeof body === 'object' ? body : {}) as ScheduleInput;
}

const router = express.Router();

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(schedulesService.list(readQuery(req.query.projectPath))));
}));

router.get('/summary', asyncHandler(async (_req: Request, res: Response) => {
  res.json(createApiSuccessResponse({ proposals: schedulesService.countProposals() }));
}));

router.post('/preview', asyncHandler(async (req: Request, res: Response) => {
  const body = readInput(req.body);
  res.json(createApiSuccessResponse(schedulesService.preview(body.schedule, body.timezone)));
}));

router.get('/runs', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(schedulesService.listRuns({
    scheduleId: readQuery(req.query.scheduleId),
    projectPath: readQuery(req.query.projectPath),
    status: readQuery(req.query.status),
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  })));
}));

router.get('/runs/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(schedulesService.getRun(readParam(req.params.id, 'id'), req.query.log === '1')));
}));

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  res.status(201).json(createApiSuccessResponse(schedulesService.create(readInput(req.body), readUserId(req))));
}));

router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(schedulesService.update(readParam(req.params.id, 'id'), readInput(req.body))));
}));

router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  schedulesService.remove(readParam(req.params.id, 'id'));
  res.json(createApiSuccessResponse({ deleted: true }));
}));

router.post('/:id/run', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(schedulesService.runNow(readParam(req.params.id, 'id'))));
}));

router.post('/:id/approve', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(schedulesService.approve(readParam(req.params.id, 'id'))));
}));

router.post('/:id/duplicate', asyncHandler(async (req: Request, res: Response) => {
  res.status(201).json(createApiSuccessResponse(schedulesService.duplicate(readParam(req.params.id, 'id'))));
}));

export default router;

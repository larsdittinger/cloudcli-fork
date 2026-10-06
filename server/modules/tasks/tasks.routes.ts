import express from 'express';
import type { Request, Response } from 'express';

import { tasksService } from '@/modules/tasks/tasks.service.js';
import type { TaskInput } from '@/modules/tasks/tasks.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

function readId(value: unknown): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new AppError('A task number is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
  return id;
}

function readUserId(request: Request): number | null {
  const userId = Number((request as AuthenticatedRequest).user?.id);
  return Number.isInteger(userId) ? userId : null;
}

function readBody(request: Request): Record<string, unknown> {
  return (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>;
}

function readQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const router = express.Router();

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(tasksService.list({ projectPath: readQuery(req.query.projectPath), includeOldClosed: req.query.includeOld === '1' })));
}));

router.get('/summary', asyncHandler(async (_req: Request, res: Response) => {
  res.json(createApiSuccessResponse(tasksService.attention()));
}));

router.get('/settings', asyncHandler(async (_req: Request, res: Response) => {
  res.json(createApiSuccessResponse({ trustAgentMandates: tasksService.trustAgentMandates() }));
}));

router.put('/settings', asyncHandler(async (req: Request, res: Response) => {
  const value = readBody(req).trustAgentMandates;
  if (typeof value !== 'boolean') throw new AppError('"trustAgentMandates" must be a boolean.', { code: 'INVALID_REQUEST', statusCode: 400 });
  res.json(createApiSuccessResponse({ trustAgentMandates: tasksService.setTrustAgentMandates(value) }));
}));

router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(tasksService.get(readId(req.params.id))));
}));

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  res.status(201).json(createApiSuccessResponse(tasksService.create(readBody(req) as TaskInput, { by: 'owner', userId: readUserId(req) })));
}));

router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(tasksService.updateByOwner(readId(req.params.id), readBody(req) as TaskInput)));
}));

router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  tasksService.remove(readId(req.params.id));
  res.json(createApiSuccessResponse({ deleted: true }));
}));

router.post('/:id/status', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(tasksService.setStatus(readId(req.params.id), readBody(req).status)));
}));

router.post('/:id/comment', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(tasksService.comment(readId(req.params.id), readBody(req).text)));
}));

router.post('/:id/answer', asyncHandler(async (req: Request, res: Response) => {
  const body = readBody(req);
  res.json(createApiSuccessResponse(tasksService.answer(readId(req.params.id), { option: body.option, text: body.text })));
}));

router.post('/:id/confirm-mandate', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(tasksService.confirmMandate(readId(req.params.id))));
}));

router.post('/:id/wake', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(tasksService.wakeNow(readId(req.params.id))));
}));

export default router;

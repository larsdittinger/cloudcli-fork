import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import express from 'express';

import { channelsService } from '@/modules/channels/index.js';
import { schedulesDb } from '@/modules/database/index.js';
import { buildSchedulesGuide } from '@/modules/schedules/agent-guide.js';
import { getSchedulesMcpToken } from '@/modules/schedules/mcp-registration.service.js';
import { nextRuns, parseScheduleSpec } from '@/modules/schedules/schedule-spec.js';
import { schedulesService } from '@/modules/schedules/schedules.service.js';
import type { ScheduleInput } from '@/modules/schedules/schedules.service.js';
import { AppError } from '@/shared/utils.js';

const router = express.Router();

function readBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S.*)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function absoluteOrNull(value: unknown): string | null {
  return typeof value === 'string' && path.isAbsolute(value.trim()) ? path.resolve(value.trim()) : null;
}

function readId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError('id is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
  return value.trim();
}

/** Agents speak snake_case (like the Channels tools); the service takes the form's camelCase. */
function readProposalInput(input: Record<string, unknown>, cwd: string | null): ScheduleInput {
  return {
    name: input.name,
    projectPath: absoluteOrNull(input.project_path) ?? cwd ?? undefined,
    kind: input.kind,
    schedule: input.schedule,
    timezone: input.timezone,
    prompt: input.prompt,
    provider: input.provider,
    model: input.model,
    effort: input.effort,
    permissionMode: input.permission_mode,
    sessionMode: input.session_mode,
    command: input.command,
    timeoutSec: input.timeout_sec,
    handoff: input.handoff,
  };
}

/** Constant-time: the bridge is reachable through the public reverse proxy. */
function tokenMatches(given: string | null): boolean {
  if (!given) return false;
  const expected = Buffer.from(getSchedulesMcpToken());
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

router.use((req, res, next) => {
  if (!tokenMatches(readBearerToken(req.headers.authorization))) {
    res.status(401).json({ success: false, error: 'Invalid Schedules MCP token.' });
    return;
  }
  next();
});

router.post('/tools/:toolName', (req, res) => {
  try {
    const input = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const cwd = absoluteOrNull(input.cwd);
    let result: unknown;

    switch (req.params.toolName) {
      case 'schedules_get_info':
        result = {
          guide: buildSchedulesGuide({ publicUrl: channelsService.getPublicUrl(), cwd }),
          state: {
            yourWorkingDirectory: cwd,
            agentsAutoApprove: schedulesService.agentsAutoApprove(),
            publicUrl: channelsService.getPublicUrl(),
            schedules: schedulesService.list(),
            recentRuns: schedulesService.listRuns({ limit: 20 }).map((run) => ({ ...run, output: run.output?.slice(-2000) ?? null })),
          },
        };
        break;
      case 'schedules_propose': {
        const note = typeof input.note === 'string' ? input.note.trim().slice(0, 2000) : '';
        const proposed = schedulesService.create(readProposalInput(input, cwd), null, { note, projectPath: cwd, createdAt: new Date().toISOString() });
        // The owner lets agents schedule without approval: it goes live now (unless it cannot, e.g. a date already past).
        let schedule = proposed;
        let autoApproveError: string | null = null;
        if (schedulesService.agentsAutoApprove()) {
          try {
            schedule = schedulesService.approve(proposed.id);
          } catch (error) {
            autoApproveError = error instanceof Error ? error.message : String(error);
          }
        }
        const live = !schedule.proposal;
        result = {
          schedule,
          nextRuns: schedule.schedule ? nextRuns(parseScheduleSpec(schedule.schedule), schedule.timezone, 3).map((date) => date.toISOString()) : [],
          note: live
            ? 'Approved and enabled right away (the owner lets agents schedule without approval). Tell the user what you scheduled and when it runs next.'
            : `Proposal saved DISABLED.${autoApproveError ? ` It could not go live on its own: ${autoApproveError}` : ''} Tell the user to approve it in the Schedules tab of the project (card → Approve).`,
        };
        break;
      }
      case 'schedules_withdraw_proposal': {
        const id = readId(input.id);
        const row = schedulesDb.get(id);
        if (!row) throw new AppError('Schedule not found.', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
        if (!row.proposal) throw new AppError('Only pending proposals can be withdrawn; approved schedules are managed by the user.', { code: 'SCHEDULE_NOT_PROPOSAL', statusCode: 403 });
        schedulesService.remove(id);
        result = { withdrawn: true };
        break;
      }
      case 'schedules_list_runs': {
        const includeOutput = input.include_output !== false;
        result = schedulesService.listRuns({
          scheduleId: typeof input.schedule_id === 'string' ? input.schedule_id : undefined,
          status: typeof input.status === 'string' ? input.status : undefined,
          limit: typeof input.limit === 'number' ? input.limit : 20,
        }).map((run) => ({ ...run, output: includeOutput ? run.output : undefined }));
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

import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import express from 'express';

import { channelsService } from '@/modules/channels/index.js';
import { channelAccountsDb } from '@/modules/database/index.js';
import { buildTasksGuide } from '@/modules/tasks/agent-guide.js';
import { sendTaskMessage } from '@/modules/tasks/channel-link.service.js';
import { getTasksMcpToken } from '@/modules/tasks/mcp-registration.service.js';
import { tasksService } from '@/modules/tasks/tasks.service.js';
import type { PublicTask } from '@/modules/tasks/tasks.service.js';
import { AppError } from '@/shared/utils.js';

const router = express.Router();
const AGENT_EVENT_LIMIT = 40;

function readBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S.*)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function absoluteOrNull(value: unknown): string | null {
  return typeof value === 'string' && path.isAbsolute(value.trim()) ? path.resolve(value.trim()) : null;
}

function readTaskId(value: unknown): number {
  const id = typeof value === 'string' ? Number(value.replace(/^#/, '')) : Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new AppError('id must be the task number.', { code: 'INVALID_REQUEST', statusCode: 400 });
  return id;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Constant-time: the bridge is reachable through the public reverse proxy. */
function tokenMatches(given: string | null): boolean {
  if (!given) return false;
  const expected = Buffer.from(getTasksMcpToken());
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** What an agent needs in a list: enough to pick a task, not the whole card. */
function compact(task: PublicTask) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    summary: task.summary.length > 600 ? `${task.summary.slice(0, 600)}…` : task.summary,
    nextCheckAt: task.nextCheckAt,
    question: task.question?.text ?? null,
    mandateConfirmed: task.mandateConfirmed,
    running: task.running !== null,
    projectPath: task.projectPath,
  };
}

function accounts() {
  return channelAccountsDb.list().filter((account) => account.proposal === null).map((account) => ({
    id: account.id,
    type: account.type,
    label: account.label,
    status: account.status,
    agentSend: account.agent_send,
  }));
}

router.use((req, res, next) => {
  if (!tokenMatches(readBearerToken(req.headers.authorization))) {
    res.status(401).json({ success: false, error: 'Invalid Tasks MCP token.' });
    return;
  }
  next();
});

router.post('/tools/:toolName', async (req, res) => {
  try {
    const input = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const cwd = absoluteOrNull(input.cwd);
    let result: unknown;

    switch (req.params.toolName) {
      case 'tasks_get_info':
        result = {
          guide: buildTasksGuide({ publicUrl: channelsService.getPublicUrl(), cwd }),
          state: {
            yourWorkingDirectory: cwd,
            openTasks: tasksService.list().filter((task) => task.status !== 'done' && task.status !== 'cancelled').map(compact),
            channelsEnabled: channelsService.isEnabled(),
            channelAccounts: accounts(),
          },
        };
        break;
      case 'tasks_list': {
        const status = optionalString(input.status) ?? 'open';
        const projectPath = absoluteOrNull(input.project_path) ?? undefined;
        const all = tasksService.list({ projectPath, includeOldClosed: status !== 'open' });
        result = all
          .filter((task) => status === 'all' || (status === 'open' ? task.status !== 'done' && task.status !== 'cancelled' : task.status === status))
          .map(compact);
        break;
      }
      case 'tasks_get': {
        const detail = tasksService.get(readTaskId(input.id), { eventLimit: input.all_events === true ? undefined : AGENT_EVENT_LIMIT });
        result = { ...detail, note: detail.eventCount > detail.events.length ? `Showing the newest ${detail.events.length} of ${detail.eventCount} diary entries; all_events=true for all.` : undefined };
        break;
      }
      case 'tasks_create': {
        const task = tasksService.create({
          title: input.title,
          brief: input.brief,
          mandate: input.mandate,
          projectPath: absoluteOrNull(input.project_path) ?? undefined,
          nextCheckInMinutes: input.start_in_minutes,
        }, { by: 'agent', cwd });
        result = { task, note: `Task #${task.id} created and starting in ${task.projectPath}. Its mandate waits for the owner: ask them to confirm it in the Tasks tab — until then messages are drafts.` };
        break;
      }
      case 'tasks_update':
        result = tasksService.agentUpdate(readTaskId(input.id), {
          summary: input.summary,
          checklist: input.checklist,
          status: input.status,
          nextCheckAt: input.next_check_at,
          nextCheckInMinutes: input.next_check_in_minutes,
        });
        break;
      case 'tasks_log':
        result = compact(tasksService.log(readTaskId(input.id), input.text));
        break;
      case 'tasks_ask_owner': {
        const task = tasksService.ask(readTaskId(input.id), { question: input.question, options: input.options });
        result = { task: compact(task), note: 'The task now waits for the owner; their answer wakes you. End this turn.' };
        break;
      }
      case 'tasks_send_message': {
        const taskId = readTaskId(input.task_id);
        const text = typeof input.text === 'string' ? input.text : '';
        result = await sendTaskMessage({
          taskId,
          accountId: optionalString(input.account_id),
          to: optionalString(input.to),
          subject: optionalString(input.subject),
          text,
          replyToMessageId: optionalString(input.reply_to_message_id),
          sessionId: tasksService.get(taskId).task.running?.sessionId ?? null,
        });
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

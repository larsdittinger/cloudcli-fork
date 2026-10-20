import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import express, { type Request, type Response } from 'express';

import { channelsService, isolatedProjectAccounts } from '@/modules/channels/index.js';
import { channelAccountsDb, tasksDb } from '@/modules/database/index.js';
import { ISOLATED_DENIED_TEXT } from '@/modules/isolation/index.js';
import type { SandboxApiRequest, SandboxMcpScope } from '@/modules/isolation/index.js';
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

/**
 * Agents change only tasks run in their own project (the MCP process's cwd),
 * so a chat elsewhere — or one task's agent — cannot steer another task.
 * Reading stays open.
 */
function requireOwnTask(value: unknown, cwd: string | null, options: { running?: boolean } = {}): number {
  const id = readTaskId(value);
  const task = tasksDb.get(id);
  if (!task) throw new AppError(`Task #${id} not found.`, { code: 'TASK_NOT_FOUND', statusCode: 404 });
  if (!cwd || path.resolve(task.project_path) !== cwd) {
    throw new AppError(`Task #${id} is run by the agent in ${task.project_path}; only that agent may change it.`, { code: 'TASK_NOT_YOURS', statusCode: 403 });
  }
  if (options.running && !task.running_session_id) {
    throw new AppError(`Task #${id} is not running right now; messages go out only during the task's own run.`, { code: 'TASK_NOT_RUNNING', statusCode: 409 });
  }
  return id;
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

/**
 * Who calls: the app's own agents with the global token, or an isolated agent's run (main.sock) whose
 * project and task come from its run token — never from the request body.
 */
type McpCaller = { kind: 'global' } | { kind: 'run'; scope: SandboxMcpScope };

/** Tools an isolated run may use on the task it runs for; without a task only the info and a proposal. */
const RUN_TASK_TOOLS = new Set(['tasks_get_info', 'tasks_get', 'tasks_update', 'tasks_log', 'tasks_ask_owner', 'tasks_send_message', 'tasks_create']);
const RUN_FREE_TOOLS = new Set(['tasks_get_info', 'tasks_create']);

const deniedToRun = () => new AppError(ISOLATED_DENIED_TEXT, { code: 'ISOLATED_AGENT_DENIED', statusCode: 403 });

/** An isolated run reaches only the task its token was minted for. */
function runTaskId(scope: SandboxMcpScope, value: unknown): number {
  const id = readTaskId(value);
  if (scope.taskId === undefined || id !== scope.taskId) throw deniedToRun();
  return id;
}

/**
 * tasks_get_info for an isolated run: its own task only. Without one, no tasks at all — a prompt-injected agent
 * could paste the project's other cards into a reply.
 */
function isolatedInfo(scope: SandboxMcpScope, cwd: string) {
  const tasks = scope.taskId !== undefined
    ? tasksService.list({ includeOldClosed: true }).filter((task) => task.id === scope.taskId)
    : [];
  return {
    guide: buildTasksGuide({ publicUrl: channelsService.getPublicUrl(), cwd }),
    state: {
      isolated: true,
      note: scope.taskId !== undefined
        ? `You are an isolated agent running task #${scope.taskId}: you can read and change only this task. A task you create is a proposal the owner starts, and its mandate always waits for the owner.`
        : 'You are an isolated agent and no task runs here: tasks_create files a proposal the owner starts, and its mandate always waits for the owner.',
      yourWorkingDirectory: cwd,
      openTasks: tasks.map(compact),
      // The owner's switch does not apply to isolated agents.
      trustAgentMandates: false,
      channelsEnabled: channelsService.isEnabled(),
      channelAccounts: isolatedProjectAccounts(scope.projectId),
    },
  };
}

async function runTool(caller: McpCaller, toolName: string, input: Record<string, unknown>): Promise<unknown> {
  const scope = caller.kind === 'run' ? caller.scope : undefined;
  if (scope && !(scope.taskId !== undefined ? RUN_TASK_TOOLS : RUN_FREE_TOOLS).has(toolName)) throw deniedToRun();
  // An isolated run works in its token's project, whatever cwd it sends.
  const cwd = scope ? path.resolve(scope.projectPath) : absoluteOrNull(input.cwd);
  const ownId = (value: unknown) => (scope ? runTaskId(scope, value) : value);
  let result: unknown;

  switch (toolName) {
    case 'tasks_get_info':
      if (scope) {
        result = isolatedInfo(scope, path.resolve(scope.projectPath));
        break;
      }
      result = {
        guide: buildTasksGuide({ publicUrl: channelsService.getPublicUrl(), cwd }),
        state: {
          yourWorkingDirectory: cwd,
          openTasks: tasksService.list().filter((task) => task.status !== 'done' && task.status !== 'cancelled').map(compact),
          trustAgentMandates: tasksService.trustAgentMandates(),
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
      const detail = tasksService.get(readTaskId(ownId(input.id)), { eventLimit: input.all_events === true ? undefined : AGENT_EVENT_LIMIT });
      result = { ...detail, note: detail.eventCount > detail.events.length ? `Showing the newest ${detail.events.length} of ${detail.eventCount} diary entries; all_events=true for all.` : undefined };
      break;
    }
    case 'tasks_create': {
      const task = tasksService.create({
        title: input.title,
        brief: input.brief,
        mandate: input.mandate,
        // An isolated agent's task runs in its own (isolated) project again, never where it points.
        projectPath: scope ? path.resolve(scope.projectPath) : absoluteOrNull(input.project_path) ?? undefined,
        nextCheckInMinutes: input.start_in_minutes,
      }, { by: 'agent', cwd, isolated: Boolean(scope) });
      result = {
        task,
        note: scope
          ? `Task #${task.id} is only a proposal: the owner decides in the Agent tasks tab whether it starts and confirms its mandate. Mention it in your summary.`
          : task.question?.by === 'system'
          ? `Task #${task.id} is only a proposal: a task is running in this project, and tasks do not start other tasks on their own. The owner decides in the Agent tasks tab whether it starts; mention it in your summary.`
          : task.mandateConfirmed
          ? `Task #${task.id} created and starting in ${task.projectPath}; the owner trusts agents' mandates, so it works within the mandate right away. Tell them the task number.`
          : `Task #${task.id} created and starting in ${task.projectPath}. Its mandate waits for the owner: ask them to confirm it in the Agent tasks tab — until then messages are drafts.`,
      };
      break;
    }
    case 'tasks_update':
      result = tasksService.agentUpdate(requireOwnTask(ownId(input.id), cwd), {
        summary: input.summary,
        checklist: input.checklist,
        status: input.status,
        nextCheckAt: input.next_check_at,
        nextCheckInMinutes: input.next_check_in_minutes,
      });
      break;
    case 'tasks_log':
      result = compact(tasksService.log(requireOwnTask(ownId(input.id), cwd), input.text));
      break;
    case 'tasks_ask_owner': {
      const task = tasksService.ask(requireOwnTask(ownId(input.id), cwd), { question: input.question, options: input.options });
      result = { task: compact(task), note: 'The task now waits for the owner; their answer wakes you. End this turn.' };
      break;
    }
    case 'tasks_send_message': {
      const taskId = requireOwnTask(ownId(input.task_id), cwd, { running: true });
      // The run token is this session's: a run of the same task in another session is not this run.
      if (scope && tasksDb.get(taskId)?.running_session_id !== scope.sessionId) {
        throw new AppError(`Task #${taskId} is not running in this session; messages go out only during the task's own run.`, { code: 'TASK_NOT_RUNNING', statusCode: 409 });
      }
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
      throw new AppError(`Unknown tool: ${toolName}`, { code: 'UNKNOWN_TOOL', statusCode: 404 });
  }
  return result;
}

async function respond(caller: McpCaller, req: Request, res: Response): Promise<void> {
  try {
    const input = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    res.json({ success: true, data: await runTool(caller, String(req.params.toolName ?? ''), input) });
  } catch (error) {
    const status = error instanceof AppError ? error.statusCode : 500;
    res.status(status).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
}

router.post('/tools/:toolName', (req, res) => {
  void respond({ kind: 'global' }, req, res);
});

/**
 * The same tools for isolated agents, mounted on main.sock only (registerSandboxMcpRouter): the sandbox API
 * has checked the run token and set the run's scope. The global token never reaches this router.
 */
export const tasksSandboxMcpRoutes = express.Router();
tasksSandboxMcpRoutes.post('/tools/:toolName', (req, res) => {
  const scope = (req as SandboxApiRequest).isolationScope;
  if (!scope) {
    res.status(401).json({ success: false, error: 'Invalid or expired run token.' });
    return;
  }
  void respond({ kind: 'run', scope }, req, res);
});

export default router;

#!/usr/bin/env node
// The MCP executable must load the root environment bootstrap before reading configuration.
// eslint-disable-next-line boundaries/no-unknown
import '../../load-env.js';

/**
 * `cloudcli-tasks` — the MCP server agents use to run long-running tasks:
 * read the card, update the summary and plan, ask the owner, message people
 * outside. Every tool is a thin call into the local CloudCLI API. The process
 * runs in the agent's project, so its cwd is sent along as the default
 * project of a new task.
 */

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const apiUrl = (process.env.CLOUDCLI_TASKS_API_URL || 'http://127.0.0.1:3001/api/tasks-mcp').replace(/\/$/, '');
const apiToken = process.env.CLOUDCLI_TASKS_MCP_TOKEN || '';
const API_TIMEOUT_MS = 60_000;

async function callTasksApi(toolName: string, input: Record<string, unknown>) {
  if (!apiToken) {
    throw new Error('CLOUDCLI_TASKS_MCP_TOKEN is not configured.');
  }
  const response = await fetch(`${apiUrl}/tools/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, cwd: process.cwd() }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const data = await response.json() as { success?: boolean; data?: unknown; error?: string };
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Tasks API request failed (${response.status})`);
  }
  return data.data;
}

const readString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
};

const ID = { type: 'number', description: 'Task number (the N in #N).' };

const tools: ToolDefinition[] = [
  {
    name: 'tasks_get_info',
    description: 'Start here. Guide to CloudCLI Tasks (long-running tasks whose card is your memory: one step per wake-up, summary, checklist, next check, questions to the owner, messages that route replies back) plus a live overview of tasks and Channels accounts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tasks_list',
    description: 'List tasks (open ones by default) with status, summary and next check.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'all', 'new', 'working', 'waiting_external', 'waiting_owner', 'done', 'cancelled'], description: 'Default open.' },
        project_path: { type: 'string', description: 'Only tasks run in this project.' },
      },
    },
  },
  {
    name: 'tasks_get',
    description: 'The whole card of one task: brief, mandate (and whether the owner confirmed it), summary, checklist, open question, diary and the messages it sent.',
    inputSchema: {
      type: 'object',
      properties: { id: ID, all_events: { type: 'boolean', description: 'Whole diary instead of the newest 40 entries.' } },
      required: ['id'],
    },
  },
  {
    name: 'tasks_create',
    description: 'Create a long-running task for something that takes days (waiting for replies, follow-ups). It starts right away in project_path; its mandate waits for the owner to confirm (until then outgoing messages are only drafts).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short, e.g. "Tiskárna na etikety: 3 nabídky".' },
        brief: { type: 'string', description: 'Goal, what done looks like, deadlines, constraints — everything the owner said.' },
        mandate: { type: 'string', description: 'Exactly what the agent may do alone (who it may contact, how many, what never), from the owner\'s words.' },
        project_path: { type: 'string', description: 'Absolute path of the agent project that runs long tasks; defaults to your working directory.' },
        start_in_minutes: { type: 'number', description: 'Start later instead of now.' },
      },
      required: ['title', 'brief'],
    },
  },
  {
    name: 'tasks_update',
    description: 'Update your task card: summary (the whole current state, rewritten), checklist, status (working | waiting_external | done | cancelled) and when to look again. Brief and mandate belong to the owner.',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        summary: { type: 'string' },
        checklist: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text'] } },
        status: { type: 'string', enum: ['working', 'waiting_external', 'done', 'cancelled'] },
        next_check_in_minutes: { type: 'number', description: 'Wake me up in N minutes (max 90 days).' },
        next_check_at: { type: 'string', description: 'Or an ISO date-time; null clears it.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'tasks_log',
    description: 'Add an entry to the task diary (what you did, what you found).',
    inputSchema: { type: 'object', properties: { id: ID, text: { type: 'string' } }, required: ['id', 'text'] },
  },
  {
    name: 'tasks_ask_owner',
    description: 'Ask the owner a decision (money, orders, anything outside the mandate). The task waits for them and shows the options as buttons; their answer wakes you. End your turn after asking.',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        question: { type: 'string', description: 'Short and self-contained; the numbers they need are in the summary.' },
        options: { type: 'array', items: { type: 'string' }, description: '2-4 short choices (max 6, 80 chars each). They can also write their own answer.' },
      },
      required: ['id', 'question'],
    },
  },
  {
    name: 'tasks_send_message',
    description: 'Send an e-mail / WhatsApp / webhook message for a task through a Channels account. Adds the [#N] tag to e-mail subjects and routes replies back to the task (they wake you). Unconfirmed mandate or an account in draft mode → it waits as a draft for the owner.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: ID,
        account_id: { type: 'string', description: 'Channels account (channels_list_accounts). Not needed with reply_to_message_id.' },
        to: { type: 'string', description: 'E-mail address or phone number. With reply_to_message_id defaults to the sender.' },
        subject: { type: 'string', description: 'E-mail subject (required for a new e-mail).' },
        text: { type: 'string' },
        reply_to_message_id: { type: 'string', description: 'Answer a received message in its thread (id from the diary entry).' },
      },
      required: ['task_id', 'text'],
    },
  },
];

function jsonResponse(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

async function callTool(name: string, args: Record<string, unknown>) {
  if (!tools.some((tool) => tool.name === name)) {
    throw new Error(`Unknown tool: ${name}`);
  }
  // Validation lives server-side; the arguments go through as given.
  return jsonResponse(await callTasksApi(name, args));
}

async function handleMessage(message: JsonRpcRequest) {
  if (message.method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'cloudcli-tasks', version: '1.0.0' },
    };
  }
  if (message.method === 'tools/list') {
    return { tools };
  }
  if (message.method === 'tools/call') {
    const params = message.params || {};
    const name = readString(params.name, 'name');
    const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
    return callTool(name, args);
  }
  if (message.method.startsWith('notifications/')) {
    return undefined;
  }
  throw new Error(`Unsupported method: ${message.method}`);
}

function writeMessage(message: Record<string, unknown>) {
  // MCP stdio transport: newline-delimited JSON, one message per line.
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id: string | number | null | undefined, result: unknown) {
  if (id === undefined) return;
  writeMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id: string | number | null | undefined, error: unknown) {
  if (id === undefined) return;
  writeMessage({
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
  });
}

let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newlineIndex: number;
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const rawMessage = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!rawMessage) continue;

    void (async () => {
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(rawMessage) as JsonRpcRequest;
      } catch (error) {
        sendError(null, error);
        return;
      }
      try {
        const result = await handleMessage(request);
        sendResult(request.id, result);
      } catch (error) {
        sendError(request.id, error);
      }
    })();
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});

#!/usr/bin/env node
// The MCP executable must load the root environment bootstrap before reading configuration.
// eslint-disable-next-line boundaries/no-unknown
import '../../load-env.js';

/**
 * `cloudcli-schedules` — the MCP server agents use to read and propose
 * scheduled AI prompts and scripts. Every tool is a thin call into the local
 * CloudCLI API, which stores proposals disabled until an admin approves them.
 * The process runs in the agent's project, so its cwd is sent along as the
 * default project of a proposal.
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

const apiUrl = (process.env.CLOUDCLI_SCHEDULES_API_URL || 'http://127.0.0.1:3001/api/schedules-mcp').replace(/\/$/, '');
const apiToken = process.env.CLOUDCLI_SCHEDULES_MCP_TOKEN || '';
const API_TIMEOUT_MS = 60_000;

async function callSchedulesApi(toolName: string, input: Record<string, unknown>) {
  if (!apiToken) {
    throw new Error('CLOUDCLI_SCHEDULES_MCP_TOKEN is not configured.');
  }
  const response = await fetch(`${apiUrl}/tools/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, cwd: process.cwd() }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const data = await response.json() as { success?: boolean; data?: unknown; error?: string };
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Schedules API request failed (${response.status})`);
  }
  return data.data;
}

const readString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
};

const SCHEDULE_SCHEMA = {
  type: 'object',
  description: 'daily {type,time:"HH:mm"} | weekly {type,days:[1..7],time} (1=Monday) | monthly {type,day:1..31|"last",time} | interval {type,every,unit:"minutes"|"hours"} | once {type,at:ISO} | cron {type,expression}',
};

const tools: ToolDefinition[] = [
  {
    name: 'schedules_get_info',
    description: 'Start here. Guide to CloudCLI Schedules (scheduled AI prompts that run as sidebar chats, scheduled scripts, script → agent hand-off, schedule formats, proposals) plus the live list of schedules, recent runs and your working directory.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'schedules_propose',
    description: 'Propose a scheduled AI prompt or script. It is saved DISABLED and runs only after the user approves it in the project\'s Schedules tab. The response repeats the schedule in words and lists the next 3 runs — check them. Read schedules_get_info first.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        note: { type: 'string', description: 'One or two sentences for the user: what it does and why.' },
        kind: { type: 'string', enum: ['prompt', 'script'] },
        schedule: SCHEDULE_SCHEMA,
        project_path: { type: 'string', description: 'Absolute project path; defaults to your working directory.' },
        timezone: { type: 'string', description: 'IANA zone, default Europe/Prague.' },
        prompt: { type: 'string', description: 'kind=prompt: the prompt. kind=script with hand-off: template, {{output}} = script stdout.' },
        provider: { type: 'string', description: 'Default "claude".' },
        model: { type: 'string' },
        effort: { type: 'string' },
        permission_mode: { type: 'string', enum: ['bypassPermissions', 'default', 'acceptEdits', 'plan'], description: 'Default bypassPermissions (nobody is there to approve tool calls).' },
        session_mode: { type: 'string', enum: ['new', 'continue'], description: 'new = a fresh chat per run (default); continue = one chat across runs.' },
        command: { type: 'string', description: 'kind=script: shell command run with bash -lc in the project, e.g. ./scripts/check_mail.py' },
        timeout_sec: { type: 'number', description: 'kind=script, default 1800.' },
        handoff: { type: 'string', enum: ['none', 'on_output'], description: 'kind=script: on_output starts an AI chat when the script prints something.' },
      },
      required: ['name', 'kind', 'schedule', 'note'],
    },
  },
  {
    name: 'schedules_withdraw_proposal',
    description: 'Delete one of your pending (not yet approved) schedule proposals. Approved schedules cannot be changed or deleted by agents.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'schedules_list_runs',
    description: 'Run history: status (running, succeeded, failed, timeout, skipped, missed), times, script output tail, chat session id of AI runs.',
    inputSchema: {
      type: 'object',
      properties: {
        schedule_id: { type: 'string' },
        status: { type: 'string', enum: ['running', 'succeeded', 'failed', 'timeout', 'skipped', 'missed'] },
        limit: { type: 'number', description: 'Default 20, max 500.' },
        include_output: { type: 'boolean', description: 'Default true.' },
      },
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
  return jsonResponse(await callSchedulesApi(name, args));
}

async function handleMessage(message: JsonRpcRequest) {
  if (message.method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'cloudcli-schedules', version: '1.0.0' },
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

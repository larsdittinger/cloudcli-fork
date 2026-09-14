#!/usr/bin/env node
// The MCP executable must load the root environment bootstrap before reading configuration.
// eslint-disable-next-line boundaries/no-unknown
import '../../load-env.js';

/**
 * `cloudcli-channels` — the MCP server agents use to answer inbound e-mail /
 * WhatsApp / webhook messages. Every tool is a thin call into the local
 * CloudCLI API; permissions (reply mode, who may be written to) live there.
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

const apiUrl = (process.env.CLOUDCLI_CHANNELS_API_URL || 'http://127.0.0.1:3001/api/channels-mcp').replace(/\/$/, '');
const apiToken = process.env.CLOUDCLI_CHANNELS_MCP_TOKEN || '';
const API_TIMEOUT_MS = Number.parseInt(process.env.CLOUDCLI_CHANNELS_API_TIMEOUT_MS || '60000', 10);

const readString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
};

const readOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

async function callChannelsApi(toolName: string, input: Record<string, unknown>) {
  if (!apiToken) {
    throw new Error('CLOUDCLI_CHANNELS_MCP_TOKEN is not configured.');
  }
  const response = await fetch(`${apiUrl}/tools/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const data = await response.json() as { success?: boolean; data?: unknown; error?: string };
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Channels API request failed (${response.status})`);
  }
  return data.data;
}

const tools: ToolDefinition[] = [
  {
    name: 'channels_reply',
    description: 'Reply to an inbound message (e-mail, WhatsApp, webhook) through the same account and thread it arrived on. Use the message id from your prompt. Depending on the rule that handled the message, the reply is sent immediately or saved as a draft for the user to approve — in the draft case do NOT try to send it again.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'The CloudCLI id of the inbound message you are answering.' },
        text: { type: 'string', description: 'Plain-text reply. For e-mail the subject and threading headers are added automatically.' },
      },
      required: ['message_id', 'text'],
    },
  },
  {
    name: 'channels_send_message',
    description: 'Send a new message to any recipient through a channel account (not a reply). Allowed only when the account permits agent sends; it may be saved as a draft for the user to approve.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Account id from channels_list_accounts.' },
        to: { type: 'string', description: 'E-mail address or phone number in international format (+420…).' },
        text: { type: 'string' },
        subject: { type: 'string', description: 'E-mail subject (ignored for WhatsApp).' },
      },
      required: ['account_id', 'to', 'text'],
    },
  },
  {
    name: 'channels_get_message',
    description: 'Fetch the full text, headers and attachment paths of an inbound message when the prompt only had a summary.',
    inputSchema: {
      type: 'object',
      properties: { message_id: { type: 'string' } },
      required: ['message_id'],
    },
  },
  {
    name: 'channels_list_messages',
    description: 'List recent inbound messages, optionally for one account or one thread (thread_key) to see the earlier conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string' },
        thread_key: { type: 'string', description: 'Requires account_id; returns the newest messages of that conversation.' },
        limit: { type: 'number', description: 'Default 20, max 100.' },
      },
    },
  },
  {
    name: 'channels_list_accounts',
    description: 'List the configured channel accounts (e-mail, WhatsApp, webhook), their connection status and whether agents may send through them.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function jsonResponse(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'channels_reply':
      return jsonResponse(await callChannelsApi(name, {
        message_id: readString(args.message_id, 'message_id'),
        text: readString(args.text, 'text'),
      }));
    case 'channels_send_message':
      return jsonResponse(await callChannelsApi(name, {
        account_id: readString(args.account_id, 'account_id'),
        to: readString(args.to, 'to'),
        text: readString(args.text, 'text'),
        subject: readOptionalString(args.subject),
      }));
    case 'channels_get_message':
      return jsonResponse(await callChannelsApi(name, { message_id: readString(args.message_id, 'message_id') }));
    case 'channels_list_messages':
      return jsonResponse(await callChannelsApi(name, {
        account_id: readOptionalString(args.account_id),
        thread_key: readOptionalString(args.thread_key),
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      }));
    case 'channels_list_accounts':
      return jsonResponse(await callChannelsApi(name, {}));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMessage(message: JsonRpcRequest) {
  if (message.method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'cloudcli-channels', version: '1.0.0' },
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

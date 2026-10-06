#!/usr/bin/env node
// The MCP executable must load the root environment bootstrap before reading configuration.
// eslint-disable-next-line boundaries/no-unknown
import '../../load-env.js';

/**
 * `cloudcli-channels` — the MCP server agents use to answer inbound e-mail /
 * WhatsApp / webhook messages, propose their own channel setup and build
 * prompt links. Every tool is a thin call into the local CloudCLI API;
 * permissions (reply mode, who may be written to, proposal approval) live there.
 * The process runs in the agent's project, so its cwd is sent along as the
 * default project for proposals and links.
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
    body: JSON.stringify({ ...input, cwd: process.cwd() }),
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
        text: { type: 'string', description: 'Plain-text reply, or an internal summary and reason for a human handoff. For e-mail the subject and threading headers are added automatically.' },
        action: { type: 'string', enum: ['reply', 'escalate'], description: 'Default reply. For webhooks only, escalate asks the calling application to notify a human instead of replying to the customer. The same draft/auto rule applies.' },
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
  {
    name: 'channels_get_info',
    description: 'Start here. Full guide to CloudCLI Channels (how inbound e-mail / WhatsApp / webhook messages start agents, rule options, reply modes, prompt templates, webhook payloads, prompt links, how to set yourself up through proposals) plus the live state: accounts, rules, pending proposals, public URL and your working directory.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'channels_propose_account',
    description: 'Propose a new channel account (e-mail mailbox, WhatsApp number or webhook). It is saved DISABLED and does nothing until the user approves it in Settings → Channels. For a webhook the response contains its URL and the token (shown only once). Read channels_get_info first for the config fields.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['email', 'whatsapp', 'webhook'] },
        label: { type: 'string', description: 'Short name the user recognises, e.g. "Podpora info@firma.cz".' },
        config: { type: 'object', description: 'email: host, user, port?, secure?, mailbox?, fromAddress?, smtpHost?, smtpPort?; whatsapp: phoneNumber; webhook: replyUrl?, allowEscalation?' },
        secrets: { type: 'object', description: 'email: { password } (app password) — only if the user gave it to you; webhook: { replyToken }? Omit otherwise.' },
        agent_send: { type: 'string', enum: ['off', 'draft', 'auto'], description: 'May agents send new (non-reply) messages through it. Default off.' },
        note: { type: 'string', description: 'One or two sentences for the user: why this account and what it will be used for.' },
      },
      required: ['type', 'label', 'note'],
    },
  },
  {
    name: 'channels_propose_rule',
    description: 'Propose a rule that routes matching inbound messages into a project chat. Saved DISABLED at the end of the rule list until the user approves it. A rule without a sender filter may not bypass permissions or auto-reply. Read channels_get_info first.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        note: { type: 'string', description: 'Why this rule exists and what the agent will do with the messages.' },
        account_id: { type: 'string', description: 'Limit to one account (id from channels_get_info or a fresh proposal).' },
        channel: { type: 'string', enum: ['email', 'whatsapp', 'webhook'], description: 'Or limit to every account of one type.' },
        conditions: {
          type: 'object',
          description: 'senders: ["jan@firma.cz", "@firma.cz", "+420*"], excludeSenders, subject: { contains, regex }, text: { contains, regex }, isGroup, hasAttachments, mentionsMe',
        },
        project_path: { type: 'string', description: 'Absolute project path; defaults to your working directory.' },
        provider: { type: 'string', description: 'Default "claude".' },
        model: { type: 'string' },
        effort: { type: 'string' },
        permission_mode: { type: 'string', enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] },
        prompt_template: { type: 'string', description: 'Empty = default template. Keep {{text}} and {{replyInstructions}}.' },
        conversation: { type: 'string', enum: ['thread', 'sender', 'new'] },
        reply_mode: { type: 'string', enum: ['none', 'draft', 'auto'], description: 'Default none; draft = replies wait for approval.' },
        reply_scope: { type: 'string', enum: ['sender', 'anyone'] },
      },
      required: ['name', 'note'],
    },
  },
  {
    name: 'channels_withdraw_proposal',
    description: 'Delete one of your pending (not yet approved) proposals. Approved accounts and rules cannot be changed or deleted by agents.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['account', 'rule'] },
        id: { type: 'string' },
      },
      required: ['kind', 'id'],
    },
  },
  {
    name: 'channels_whatsapp_pairing_code',
    description: 'Get a pairing code for an approved WhatsApp account waiting for pairing (status needs_pairing). The user types it on the phone: WhatsApp → Linked devices → Link a device → Link with phone number.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string' },
        phone: { type: 'string', description: 'The account phone number in international format (+420…).' },
      },
      required: ['account_id', 'phone'],
    },
  },
  {
    name: 'channels_build_link',
    description: 'Build a URL that opens CloudCLI with a prepared prompt prefilled in the composer (never sent automatically) — put it into an e-mail or message for the user. With message_id it opens the chat that message started (continues its history); with session_id a specific chat; otherwise a new chat in project_path (default: your working directory).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to prefill, max 4000 characters.' },
        message_id: { type: 'string', description: 'Inbound message id — opens its chat with history.' },
        session_id: { type: 'string' },
        project_path: { type: 'string' },
      },
      required: ['prompt'],
    },
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
        action: args.action,
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
    case 'channels_get_info':
      return jsonResponse(await callChannelsApi(name, {}));
    case 'channels_propose_account':
    case 'channels_propose_rule':
    case 'channels_withdraw_proposal':
    case 'channels_whatsapp_pairing_code':
    case 'channels_build_link':
      // Validation lives server-side; the arguments go through as given.
      return jsonResponse(await callChannelsApi(name, args));
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

#!/usr/bin/env node
// The MCP executable must load the root environment bootstrap before reading configuration.
// eslint-disable-next-line boundaries/no-unknown
import '../../load-env.js';

// ethia fork: screenshots are stripped from JSON results and re-attached as
// image blocks — see browser-use-mcp-format.ts.
import { jsonResponse, screenshotResponse } from './browser-use-mcp-format.js';

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

const readString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
};

const readOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const readNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const readOptionalBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

// ethia fork: device emulation arguments shared by create_session and emulate_device.
const readEmulationArgs = (args: Record<string, unknown>) => ({
  device: readOptionalString(args.device),
  width: readNumber(args.width),
  height: readNumber(args.height),
  deviceScaleFactor: readNumber(args.deviceScaleFactor),
  isMobile: readOptionalBoolean(args.isMobile),
  hasTouch: readOptionalBoolean(args.hasTouch),
  landscape: readOptionalBoolean(args.landscape),
  userAgent: readOptionalString(args.userAgent),
});

const apiUrl = (process.env.CLOUDCLI_BROWSER_USE_API_URL || 'http://127.0.0.1:3001/api/browser-use-mcp').replace(/\/$/, '');
const apiToken = process.env.CLOUDCLI_BROWSER_USE_MCP_TOKEN || '';
const API_TIMEOUT_MS = Number.parseInt(process.env.CLOUDCLI_BROWSER_USE_API_TIMEOUT_MS || '60000', 10);

async function callBrowserUseApi(toolName: string, input: Record<string, unknown>) {
  if (!apiToken) {
    throw new Error('CLOUDCLI_BROWSER_USE_MCP_TOKEN is not configured.');
  }

  const response = await fetch(`${apiUrl}/tools/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const data = await response.json() as { success?: boolean; data?: unknown; error?: string };
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Browser API request failed (${response.status})`);
  }
  return data.data;
}

const sessionIdSchema = {
  type: 'object',
  properties: {
    sessionId: { type: 'string', description: 'Browser session id.' },
  },
  required: ['sessionId'],
};

const tools: ToolDefinition[] = [
  {
    name: 'browser_create_session',
    description: 'Create a temporary Browser session that the agent can control. Optionally provide a background profileName to reuse cookies and storage, and a device (for example "iphone-15" or "pixel-7") to start in a mobile viewport.',
    inputSchema: {
      type: 'object',
      properties: {
        profileName: { type: 'string', description: 'Optional background profile name for persistent browser storage.' },
        device: { type: 'string', description: 'Device preset id from browser_list_devices, e.g. iphone-15, pixel-7, ipad-mini, desktop.' },
        width: { type: 'number', description: 'Custom viewport width in CSS pixels.' },
        height: { type: 'number', description: 'Custom viewport height in CSS pixels.' },
        deviceScaleFactor: { type: 'number', description: 'Device pixel ratio, e.g. 3 for a modern phone.' },
        isMobile: { type: 'boolean', description: 'Emulate a mobile browser (meta viewport handling).' },
        hasTouch: { type: 'boolean', description: 'Emulate touch input; clicks become taps.' },
        landscape: { type: 'boolean', description: 'Rotate the device to landscape.' },
        userAgent: { type: 'string', description: 'Override the user agent string.' },
      },
    },
  },
  {
    name: 'browser_list_devices',
    description: 'List the device presets available for mobile/tablet/desktop emulation.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_emulate_device',
    description: 'Switch a Browser session to a device preset or a custom viewport — use this to test how a page looks and behaves on a phone. Reloads the current URL when the change needs a fresh browser context.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        device: { type: 'string', description: 'Device preset id, e.g. iphone-15, iphone-se, pixel-7, ipad-mini, desktop.' },
        width: { type: 'number' },
        height: { type: 'number' },
        deviceScaleFactor: { type: 'number' },
        isMobile: { type: 'boolean' },
        hasTouch: { type: 'boolean' },
        landscape: { type: 'boolean' },
        userAgent: { type: 'string' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_console_messages',
    description: 'Read captured DevTools console output and uncaught page errors for a Browser session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        level: { type: 'string', description: 'Filter by level: log, info, warning, error (error also returns uncaught exceptions).' },
        search: { type: 'string', description: 'Only return messages containing this text.' },
        limit: { type: 'number', description: 'Maximum number of messages to return (newest last).' },
        clear: { type: 'boolean', description: 'Clear the buffer after reading.' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_network_requests',
    description: 'Read captured DevTools network activity (method, URL, status, duration, failures) for a Browser session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        urlContains: { type: 'string', description: 'Only return requests whose URL contains this text.' },
        resourceType: { type: 'string', description: 'Filter by resource type, e.g. document, script, xhr, fetch, image.' },
        onlyFailed: { type: 'boolean', description: 'Only return failed requests and 4xx/5xx responses.' },
        limit: { type: 'number' },
        clear: { type: 'boolean', description: 'Clear the buffer after reading.' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_evaluate',
    description: 'Run JavaScript in the page and return the JSON result — the DevTools console equivalent. Accepts an expression ("window.innerWidth") or a statement body ending in return.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        script: { type: 'string', description: 'JavaScript to run in the page context.' },
      },
      required: ['sessionId', 'script'],
    },
  },
  {
    name: 'browser_get_html',
    description: 'Return the rendered HTML of the page or of a single element, useful for inspecting the DOM like the DevTools elements panel.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string', description: 'Optional CSS selector; omit for the whole document.' },
        maxLength: { type: 'number', description: 'Maximum characters to return (default 50000).' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_list_sessions',
    description: 'List Browser sessions currently available to agents.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_snapshot',
    description: 'Capture the current page as an image, together with page metadata and visible body text. Other tools omit the screenshot, so call this when you need to see the page.',
    inputSchema: sessionIdSchema,
  },
  {
    name: 'browser_take_screenshot',
    description: 'Capture the current page of a Browser session as an image.',
    inputSchema: sessionIdSchema,
  },
  {
    name: 'browser_navigate',
    description: 'Navigate a Browser session to an HTTP or HTTPS URL.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['sessionId', 'url'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element by CSS selector, visible text, or x/y coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into the focused page or fill a CSS selector. Set submit to press Enter after typing.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        submit: { type: 'boolean' },
      },
      required: ['sessionId', 'text'],
    },
  },
  {
    name: 'browser_fill_form',
    description: 'Fill multiple form fields using CSS selectors.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['selector', 'value'],
          },
        },
      },
      required: ['sessionId', 'fields'],
    },
  },
  {
    name: 'browser_press_key',
    description: 'Press a keyboard key, for example Enter, Escape, Tab, or Control+A.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        key: { type: 'string' },
      },
      required: ['sessionId', 'key'],
    },
  },
  {
    name: 'browser_select_option',
    description: 'Select option values in a select element found by CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        values: { type: 'array', items: { type: 'string' } },
      },
      required: ['sessionId', 'selector', 'values'],
    },
  },
  {
    name: 'browser_wait_for',
    description: 'Wait for visible text, a URL pattern, or a short timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        text: { type: 'string' },
        url: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_tabs',
    description: 'List, open, select, or close tabs in a Browser session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        action: { type: 'string', enum: ['list', 'new', 'select', 'close'] },
        index: { type: 'number' },
        url: { type: 'string' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_close_session',
    description: 'Stop a Browser session controlled by agents.',
    inputSchema: sessionIdSchema,
  },
];

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'browser_create_session':
      return jsonResponse(await callBrowserUseApi(name, {
        profileName: readOptionalString(args.profileName),
        ...readEmulationArgs(args),
      }));
    case 'browser_list_sessions':
      return jsonResponse(await callBrowserUseApi(name, {}));
    case 'browser_list_devices':
      return jsonResponse(await callBrowserUseApi(name, {}));
    case 'browser_emulate_device':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        ...readEmulationArgs(args),
      }));
    case 'browser_console_messages':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        level: readOptionalString(args.level),
        search: readOptionalString(args.search),
        limit: readNumber(args.limit),
        clear: args.clear === true,
      }));
    case 'browser_network_requests':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        urlContains: readOptionalString(args.urlContains),
        resourceType: readOptionalString(args.resourceType),
        onlyFailed: args.onlyFailed === true,
        limit: readNumber(args.limit),
        clear: args.clear === true,
      }));
    case 'browser_evaluate':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        script: readString(args.script, 'script'),
      }));
    case 'browser_get_html':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        selector: readOptionalString(args.selector),
        maxLength: readNumber(args.maxLength),
      }));
    case 'browser_snapshot':
    case 'browser_take_screenshot':
      return screenshotResponse(await callBrowserUseApi(name, { sessionId: readString(args.sessionId, 'sessionId') }));
    case 'browser_navigate':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        url: readString(args.url, 'url'),
      }));
    case 'browser_click':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        selector: readOptionalString(args.selector),
        text: readOptionalString(args.text),
        x: readNumber(args.x),
        y: readNumber(args.y),
      }));
    case 'browser_type':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        selector: readOptionalString(args.selector),
        text: readString(args.text, 'text'),
        submit: args.submit === true,
      }));
    case 'browser_fill_form': {
      const fields = Array.isArray(args.fields)
        ? args.fields.map((field) => {
          const record = field as Record<string, unknown>;
          return {
            selector: readString(record.selector, 'field.selector'),
            value: readString(record.value, 'field.value'),
          };
        })
        : [];
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        fields,
      }));
    }
    case 'browser_press_key':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        key: readString(args.key, 'key'),
      }));
    case 'browser_select_option':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        selector: readString(args.selector, 'selector'),
        values: Array.isArray(args.values) ? args.values.filter((value): value is string => typeof value === 'string') : [],
      }));
    case 'browser_wait_for':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        text: readOptionalString(args.text),
        url: readOptionalString(args.url),
        timeoutMs: readNumber(args.timeoutMs),
      }));
    case 'browser_tabs':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        action: args.action === 'new' || args.action === 'select' || args.action === 'close' || args.action === 'list'
          ? args.action
          : undefined,
        index: readNumber(args.index),
        url: readOptionalString(args.url),
      }));
    case 'browser_close_session':
      return jsonResponse(await callBrowserUseApi(name, { sessionId: readString(args.sessionId, 'sessionId') }));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMessage(message: JsonRpcRequest) {
  if (message.method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'cloudcli-browser', version: '1.0.0' },
    };
  }

  if (message.method === 'tools/list') {
    return { tools };
  }

  if (message.method === 'tools/call') {
    const params = message.params || {};
    const name = readString(params.name, 'name');
    const args = (params.arguments && typeof params.arguments === 'object'
      ? params.arguments
      : {}) as Record<string, unknown>;
    return callTool(name, args);
  }

  if (message.method.startsWith('notifications/')) {
    return undefined;
  }

  throw new Error(`Unsupported method: ${message.method}`);
}

function writeMessage(message: Record<string, unknown>) {
  // MCP stdio transport uses newline-delimited JSON (one JSON-RPC message per line,
  // no embedded newlines). This is NOT the LSP Content-Length framing.
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id: string | number | null | undefined, result: unknown) {
  if (id === undefined) {
    return;
  }
  writeMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id: string | number | null | undefined, error: unknown) {
  if (id === undefined) {
    return;
  }
  writeMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newlineIndex: number;
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const rawMessage = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!rawMessage) {
      continue;
    }

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

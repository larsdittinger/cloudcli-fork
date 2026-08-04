import express from 'express';

import { browserUseService } from '@/modules/browser-use/browser-use.service.js';

const router = express.Router();

function readOptional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// ethia fork: device emulation fields accepted by create_session / emulate_device.
function readEmulationInput(input: Record<string, unknown>) {
  return {
    device: readOptional(input.device),
    width: typeof input.width === 'number' ? input.width : undefined,
    height: typeof input.height === 'number' ? input.height : undefined,
    deviceScaleFactor: typeof input.deviceScaleFactor === 'number' ? input.deviceScaleFactor : undefined,
    isMobile: typeof input.isMobile === 'boolean' ? input.isMobile : undefined,
    hasTouch: typeof input.hasTouch === 'boolean' ? input.hasTouch : undefined,
    landscape: typeof input.landscape === 'boolean' ? input.landscape : undefined,
    userAgent: readOptional(input.userAgent),
  };
}

function readBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer\s+(\S.*)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

router.use((req, res, next) => {
  const expected = browserUseService.getMcpToken();
  const token = readBearerToken(req.headers.authorization) || String(req.headers['x-browser-use-mcp-token'] || '');
  if (!token || token !== expected) {
    res.status(401).json({ success: false, error: 'Invalid Browser MCP token.' });
    return;
  }
  next();
});

router.post('/tools/:toolName', async (req, res) => {
  try {
    const input = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
    const toolName = req.params.toolName;
    let result: unknown;

    switch (toolName) {
      case 'browser_create_session':
        result = await browserUseService.createAgentSession({
          profileName: typeof input.profileName === 'string' ? input.profileName : null,
          ...readEmulationInput(input),
        });
        break;
      case 'browser_list_sessions':
        result = await browserUseService.listAgentSessions();
        break;
      // ethia fork: mobile emulation + DevTools access for agents.
      case 'browser_list_devices':
        result = browserUseService.listDevices();
        break;
      case 'browser_emulate_device':
        result = await browserUseService.agentEmulate(sessionId, readEmulationInput(input));
        break;
      case 'browser_console_messages':
        result = await browserUseService.agentDevtools(sessionId, {
          include: 'console',
          level: readOptional(input.level),
          search: readOptional(input.search),
          limit: typeof input.limit === 'number' ? input.limit : undefined,
          clear: input.clear === true,
        });
        break;
      case 'browser_network_requests':
        result = await browserUseService.agentDevtools(sessionId, {
          include: 'network',
          urlContains: readOptional(input.urlContains),
          resourceType: readOptional(input.resourceType),
          onlyFailed: input.onlyFailed === true,
          limit: typeof input.limit === 'number' ? input.limit : undefined,
          clear: input.clear === true,
        });
        break;
      case 'browser_evaluate':
        result = await browserUseService.agentEvaluate(sessionId, String(input.script || ''));
        break;
      case 'browser_get_html':
        result = await browserUseService.agentGetHtml(sessionId, {
          selector: readOptional(input.selector),
          maxLength: typeof input.maxLength === 'number' ? input.maxLength : undefined,
        });
        break;
      case 'browser_snapshot':
      case 'browser_take_screenshot':
        result = await browserUseService.agentSnapshot(sessionId);
        break;
      case 'browser_navigate':
        result = await browserUseService.agentNavigate(sessionId, String(input.url || ''));
        break;
      case 'browser_click':
        result = await browserUseService.agentClick(sessionId, {
          selector: typeof input.selector === 'string' ? input.selector : undefined,
          text: typeof input.text === 'string' ? input.text : undefined,
          x: typeof input.x === 'number' ? input.x : undefined,
          y: typeof input.y === 'number' ? input.y : undefined,
        });
        break;
      case 'browser_type':
        result = await browserUseService.agentType(sessionId, {
          selector: typeof input.selector === 'string' ? input.selector : undefined,
          text: String(input.text || ''),
          submit: input.submit === true,
        });
        break;
      case 'browser_fill_form':
        result = await browserUseService.agentFillForm(
          sessionId,
          Array.isArray(input.fields)
            ? input.fields.map((field) => {
              const record = field as Record<string, unknown>;
              return {
                selector: String(record.selector || ''),
                value: String(record.value || ''),
              };
            })
            : [],
        );
        break;
      case 'browser_press_key':
        result = await browserUseService.agentPressKey(sessionId, String(input.key || ''));
        break;
      case 'browser_select_option':
        result = await browserUseService.agentSelectOption(
          sessionId,
          String(input.selector || ''),
          Array.isArray(input.values) ? input.values.filter((value): value is string => typeof value === 'string') : [],
        );
        break;
      case 'browser_wait_for':
        result = await browserUseService.agentWaitFor(sessionId, {
          text: typeof input.text === 'string' ? input.text : undefined,
          url: typeof input.url === 'string' ? input.url : undefined,
          timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
        });
        break;
      case 'browser_tabs':
        result = await browserUseService.agentTabs(sessionId, {
          action: input.action === 'new' || input.action === 'select' || input.action === 'close' || input.action === 'list'
            ? input.action
            : undefined,
          index: typeof input.index === 'number' ? input.index : undefined,
          url: typeof input.url === 'string' ? input.url : undefined,
        });
        break;
      case 'browser_close_session':
        result = await browserUseService.agentStopSession(sessionId);
        break;
      default:
        res.status(404).json({ success: false, error: `Unknown Browser MCP tool "${toolName}".` });
        return;
    }

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Browser MCP tool failed.',
    });
  }
});

export default router;

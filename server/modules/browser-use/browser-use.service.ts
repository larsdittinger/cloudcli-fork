import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

import {
  attachPageRecorder,
  DevtoolsRecorder,
} from '@/modules/browser-use/browser-devtools.js';
import {
  defaultEmulation,
  isViewportOnlyChange,
  listPresets,
  resolveEmulation,
  toContextOptions,
  type BrowserEmulation,
  type EmulationInput,
} from '@/modules/browser-use/browser-emulation.js';
import { appConfigDb } from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/index.js';
import { getModuleDirectory } from '@/shared/utils.js';

const require = createRequire(import.meta.url);
const __dirname = getModuleDirectory(import.meta.url);
const IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true';
const MAX_SESSIONS_PER_OWNER = Number.parseInt(process.env.CLOUDCLI_BROWSER_USE_MAX_SESSIONS_PER_OWNER || '3', 10);
const SESSION_TTL_MS = Number.parseInt(process.env.CLOUDCLI_BROWSER_USE_SESSION_TTL_MS || String(30 * 60 * 1000), 10);
const BROWSER_USE_SETTINGS_KEY = 'browser_use_settings';
const BROWSER_USE_MCP_TOKEN_KEY = 'browser_use_mcp_token';

type BrowserUseRuntime = 'cloud' | 'local';
type BrowserUseSessionStatus = 'ready' | 'stopped' | 'unavailable';

type BrowserUseSession = {
  id: string;
  ownerId: string;
  createdBy: 'agent';
  runtime: BrowserUseRuntime;
  status: BrowserUseSessionStatus;
  url: string | null;
  title: string | null;
  screenshotDataUrl: string | null;
  createdAt: string;
  updatedAt: string;
  lastAction: string | null;
  message: string | null;
  profileName: string | null;
  viewport: {
    width: number;
    height: number;
  } | null;
  // ethia fork: device emulation currently applied to the session context.
  emulation: BrowserEmulation;
  cursor: {
    x: number;
    y: number;
    actor: 'agent';
  } | null;
};

type PublicBrowserUseSession = Omit<BrowserUseSession, 'ownerId'>;

type RuntimeHandle = {
  browser?: any;
  context?: any;
  page?: any;
  // ethia fork: DevTools ring buffer fed by page listeners.
  recorder?: DevtoolsRecorder;
  detachContext?: () => void;
};

type BrowserUseSettings = {
  enabled: boolean;
};

type RuntimeReadiness = {
  playwright: any | null;
  playwrightInstalled: boolean;
  chromiumInstalled: boolean;
  chromiumExecutablePath: string | null;
  installInProgress: boolean;
  installMessage: string | null;
};

type RuntimeProbe = Omit<RuntimeReadiness, 'installInProgress' | 'installMessage'>;

const sessions = new Map<string, BrowserUseSession>();
const handles = new Map<string, RuntimeHandle>();
let installPromise: Promise<{ success: boolean; message: string }> | null = null;
let lastInstallMessage: string | null = null;
let runtimeProbeCache: { value: RuntimeProbe; updatedAt: number } | null = null;

const DEFAULT_SETTINGS: BrowserUseSettings = {
  enabled: false,
};
const AGENT_OWNER_ID = 'agent';
const PROFILE_ROOT = path.join(os.homedir(), '.cloudcli', 'browser-use', 'profiles');
const MCP_SERVER_NAME = 'cloudcli-browser';
const LEGACY_MCP_SERVER_NAMES = ['cloudcli-browser-use'];
const RUNTIME_READINESS_CACHE_TTL_MS = 30_000;

function getRuntime(): BrowserUseRuntime {
  return IS_PLATFORM ? 'cloud' : 'local';
}

function readSettings(): BrowserUseSettings {
  try {
    const raw = appConfigDb.get(BROWSER_USE_SETTINGS_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }

    const parsed = JSON.parse(raw) as Partial<BrowserUseSettings>;
    return {
      enabled: parsed.enabled === true,
    };
  } catch (error: any) {
    console.warn('[Browser] Failed to read settings:', error?.message || error);
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(settings: BrowserUseSettings): BrowserUseSettings {
  const normalized = {
    enabled: settings.enabled === true,
  };

  appConfigDb.set(BROWSER_USE_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

function getOrCreateMcpToken(): string {
  const existing = appConfigDb.get(BROWSER_USE_MCP_TOKEN_KEY);
  if (existing) {
    return existing;
  }
  const token = randomBytes(32).toString('hex');
  appConfigDb.set(BROWSER_USE_MCP_TOKEN_KEY, token);
  return token;
}

function getSetupMessage(settings: BrowserUseSettings, readiness: RuntimeReadiness): string {
  if (!settings.enabled) {
    return 'Browser is disabled in settings.';
  }

  if (!readiness.playwrightInstalled) {
    return 'Install Playwright and Chromium to use browser sessions.';
  }

  if (!readiness.chromiumInstalled) {
    return 'Playwright is installed, but Chromium is missing. Install the Chromium runtime to continue.';
  }

  return readiness.installMessage || 'Browser runtime is not ready.';
}

function getPlaywright(): any | null {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

function getMcpCommand(): { command: string; args: string[] } {
  const mcpScriptPath = path.join(__dirname, 'browser-use-mcp.js');
  if (fs.existsSync(mcpScriptPath)) {
    return {
      command: process.execPath,
      args: [mcpScriptPath],
    };
  }

  return {
    command: 'cloudcli',
    args: ['browser-use-mcp'],
  };
}

function getMcpApiUrl(): string {
  const port = process.env.SERVER_PORT || process.env.PORT || '3001';
  return `http://127.0.0.1:${port}/api/browser-use-mcp`;
}

async function removeMcpServerFromAllProviders(name: string) {
  const results = await providerMcpService.removeMcpServerFromAllProviders({
    name,
    scope: 'user',
  });
  return results.map((result) => ({ ...result, name }));
}

function normalizeProfileName(profileName?: string | null): string | null {
  const normalized = String(profileName || '').trim();
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, 80);
}

function getProfilePath(profileName: string): string {
  const safeName = profileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'default';
  return path.join(PROFILE_ROOT, safeName);
}

function probeRuntime(): RuntimeProbe {
  const playwright = getPlaywright();
  const readiness: RuntimeProbe = {
    playwright,
    playwrightInstalled: Boolean(playwright),
    chromiumInstalled: false,
    chromiumExecutablePath: null,
  };

  if (!playwright) {
    return readiness;
  }

  try {
    const executablePath = playwright.chromium.executablePath();
    readiness.chromiumExecutablePath = executablePath;
    readiness.chromiumInstalled = Boolean(executablePath && fs.existsSync(executablePath));
  } catch {
    readiness.chromiumInstalled = false;
  }

  return readiness;
}

function getRuntimeReadiness(options: { force?: boolean } = {}): RuntimeReadiness {
  const now = Date.now();
  const cachedProbe = runtimeProbeCache;
  const canUseCache = !options.force
    && !installPromise
    && cachedProbe
    && now - cachedProbe.updatedAt < RUNTIME_READINESS_CACHE_TTL_MS;
  const probe = canUseCache ? cachedProbe.value : probeRuntime();

  if (!canUseCache && !installPromise) {
    runtimeProbeCache = { value: probe, updatedAt: now };
  }

  return {
    ...probe,
    installInProgress: Boolean(installPromise),
    installMessage: lastInstallMessage,
  };
}

const INSTALL_COMMAND_TIMEOUT_MS = Number.parseInt(
  process.env.CLOUDCLI_BROWSER_USE_INSTALL_TIMEOUT_MS || String(10 * 60 * 1000),
  10,
);

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: string[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(
        `${command} ${args.join(' ')} timed out after ${INSTALL_COMMAND_TIMEOUT_MS}ms.`,
      )));
    }, INSTALL_COMMAND_TIMEOUT_MS);
    timer.unref?.();

    // stdio config above guarantees the pipes exist; cross-spawn's types
    // just don't narrow them the way node's spawn overloads do.
    child.stdout?.on('data', (chunk) => output.push(String(chunk)));
    child.stderr?.on('data', (chunk) => output.push(String(chunk)));
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => finish(() => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(output.join('').trim() || `${command} ${args.join(' ')} exited with code ${code}`));
    }));
  });
}

function formatInstallError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('sudo') && message.includes('password')) {
    return 'Installing Chromium system dependencies requires administrator privileges. Run `npx playwright install-deps chromium` on the machine where CloudCLI runs, then try again.';
  }
  return message || 'Failed to install Browser runtime.';
}

async function installRuntime(): Promise<{ success: boolean; message: string }> {
  if (installPromise) {
    return installPromise;
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  runtimeProbeCache = null;
  installPromise = (async () => {
    try {
      lastInstallMessage = 'Installing Playwright package...';
      await runCommand(npmCommand, ['install', '--no-save', '--no-package-lock', 'playwright']);

      if (process.platform === 'linux') {
        lastInstallMessage = 'Installing Chromium system dependencies...';
        await runCommand(npmCommand, ['exec', '--', 'playwright', 'install-deps', 'chromium']);
      }

      lastInstallMessage = 'Installing Chromium runtime...';
      await runCommand(npmCommand, ['exec', '--', 'playwright', 'install', 'chromium']);

      lastInstallMessage = 'Browser runtime installed.';
      return { success: true, message: lastInstallMessage };
    } catch (error) {
      lastInstallMessage = formatInstallError(error);
      return { success: false, message: lastInstallMessage };
    }
  })();

  try {
    return await installPromise;
  } finally {
    installPromise = null;
    runtimeProbeCache = null;
  }
}

function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('URL is required.');
  }

  const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are supported.');
  }

  return parsed.toString();
}

function publicSession(session: BrowserUseSession): PublicBrowserUseSession {
  const { ownerId: _ownerId, ...publicFields } = session;
  return publicFields;
}

function ownerSessions(ownerId: string): BrowserUseSession[] {
  return [...sessions.values()].filter((session) => session.ownerId === ownerId);
}

async function closeHandle(sessionId: string): Promise<void> {
  const handle = handles.get(sessionId);
  handles.delete(sessionId);
  handle?.detachContext?.();
  await handle?.context?.close?.().catch(() => undefined);
  await handle?.browser?.close().catch(() => undefined);
}

async function expireStaleSessions(now = Date.now()): Promise<void> {
  await Promise.all([...sessions.values()].map(async (session) => {
    if (session.status !== 'ready') {
      return;
    }

    const updatedAt = Date.parse(session.updatedAt);
    if (!Number.isFinite(updatedAt) || now - updatedAt <= SESSION_TTL_MS) {
      return;
    }

    await closeHandle(session.id);
    session.status = 'stopped';
    session.updatedAt = new Date(now).toISOString();
    session.lastAction = 'expire';
    session.message = 'Browser session expired after inactivity.';
  }));
}

async function captureSession(session: BrowserUseSession, page: any): Promise<void> {
  // scale: 'css' keeps a phone screenshot at its CSS size — an emulated iPhone
  // renders at deviceScaleFactor 3, and the 9x larger image helps nobody.
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 72, fullPage: false, scale: 'css' });
  session.screenshotDataUrl = `data:image/jpeg;base64,${Buffer.from(screenshot).toString('base64')}`;
  session.title = await page.title().catch(() => null);
  session.url = page.url() || session.url;
  session.viewport = page.viewportSize?.() || session.viewport;
  session.updatedAt = new Date().toISOString();
}

async function getActionPoint(page: any, input: { selector?: string; text?: string; x?: number; y?: number }) {
  if (typeof input.x === 'number' && typeof input.y === 'number') {
    return { x: input.x, y: input.y };
  }

  const locator = input.selector
    ? page.locator(input.selector).first()
    : input.text
      ? page.getByText(input.text, { exact: false }).first()
      : null;

  if (!locator) {
    return null;
  }

  const box = await locator.boundingBox().catch(() => null);
  if (!box) {
    return null;
  }

  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };
}

// ethia fork: record console/network for every page in the context, including
// tabs the page itself opens, so DevTools output survives tab switches.
function attachContextRecorder(context: any, recorder: DevtoolsRecorder): () => void {
  const detachers: Array<() => void> = [];
  const attach = (page: any) => {
    try {
      detachers.push(attachPageRecorder(page, recorder));
    } catch (error: any) {
      console.warn('[Browser] Failed to attach DevTools recorder:', error?.message || error);
    }
  };

  for (const page of context.pages?.() || []) {
    attach(page);
  }
  context.on?.('page', attach);

  return () => {
    context.off?.('page', attach);
    for (const detach of detachers) {
      detach();
    }
  };
}

// ethia fork: single place that turns an emulation descriptor into a live
// Playwright context, used by session creation and by device switching.
async function launchEmulatedContext(
  playwright: any,
  emulation: BrowserEmulation,
  profileName: string | null,
): Promise<RuntimeHandle> {
  const launchOptions = {
    headless: true,
    args: ['--disable-dev-shm-usage'],
  };
  const contextOptions = {
    ...toContextOptions(emulation),
    serviceWorkers: 'block',
  };

  let browser: any | undefined;
  let context: any;
  let page: any;

  if (profileName) {
    fs.mkdirSync(PROFILE_ROOT, { recursive: true });
    context = await playwright.chromium.launchPersistentContext(getProfilePath(profileName), {
      ...launchOptions,
      ...contextOptions,
    });
    page = context.pages()[0] || await context.newPage();
  } else {
    browser = await playwright.chromium.launch(launchOptions);
    context = await browser.newContext(contextOptions);
    page = await context.newPage();
  }

  const recorder = new DevtoolsRecorder();
  const detachContext = attachContextRecorder(context, recorder);
  return { browser, context, page, recorder, detachContext };
}

function getRecorder(sessionId: string): DevtoolsRecorder {
  const recorder = handles.get(sessionId)?.recorder;
  if (!recorder) {
    throw new Error('DevTools capture is not available for this session.');
  }
  return recorder;
}

type DevtoolsQuery = {
  include?: 'console' | 'network' | 'all';
  level?: string;
  search?: string;
  urlContains?: string;
  resourceType?: string;
  onlyFailed?: boolean;
  limit?: number;
  clear?: boolean;
};

function readDevtools(sessionId: string, input: DevtoolsQuery = {}) {
  const recorder = getRecorder(sessionId);
  const include = input.include || 'all';
  const result: Record<string, unknown> = { counts: recorder.counts() };

  if (include === 'all' || include === 'console') {
    result.console = recorder.getConsole({
      level: input.level,
      search: input.search,
      limit: input.limit,
    });
  }
  if (include === 'all' || include === 'network') {
    result.network = recorder.getNetwork({
      urlContains: input.urlContains,
      resourceType: input.resourceType,
      onlyFailed: input.onlyFailed,
      limit: input.limit,
    });
  }
  if (input.clear) {
    recorder.clear();
  }
  return result;
}

async function applyEmulation(session: BrowserUseSession, input: EmulationInput): Promise<PublicBrowserUseSession> {
  if (session.status !== 'ready') {
    throw new Error(session.message || 'Browser session is not available.');
  }

  const handle = handles.get(session.id);
  if (!handle?.page) {
    throw new Error('Browser runtime handle is not available.');
  }

  const current = session.emulation || defaultEmulation();
  const next = resolveEmulation(input, current);
  const contextChanged = current.deviceScaleFactor !== next.deviceScaleFactor
    || current.isMobile !== next.isMobile
    || current.hasTouch !== next.hasTouch
    || current.userAgent !== next.userAgent;

  if (contextChanged) {
    const readiness = getRuntimeReadiness();
    if (!readiness.playwright) {
      throw new Error('Browser runtime is not available.');
    }

    const previousUrl = handle.page.url?.() || session.url;
    await closeHandle(session.id);

    let nextHandle: RuntimeHandle;
    try {
      nextHandle = await launchEmulatedContext(readiness.playwright, next, session.profileName);
    } catch (error: any) {
      // The old context is already gone, so the session cannot recover here.
      session.status = 'stopped';
      session.updatedAt = new Date().toISOString();
      session.lastAction = 'emulate';
      session.message = `Failed to reopen the browser for ${next.label}: ${error?.message || error}`;
      throw new Error(session.message);
    }

    handles.set(session.id, nextHandle);
    session.message = 'Browser session is ready.';

    if (previousUrl && /^https?:/i.test(previousUrl)) {
      await nextHandle.page
        .goto(previousUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        .catch((error: any) => {
          session.message = `Device applied, but reloading ${previousUrl} failed: ${error?.message || error}`;
        });
    }
  } else if (isViewportOnlyChange(current, next)) {
    await handle.page.setViewportSize({ width: next.width, height: next.height });
  }

  session.emulation = next;
  session.viewport = { width: next.width, height: next.height };
  session.cursor = null;
  session.lastAction = `emulate:${next.preset || `${next.width}x${next.height}`}`;
  await captureSession(session, handles.get(session.id)?.page || handle.page);
  return publicSession(session);
}

function serializeEvaluationResult(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  try {
    const json = JSON.stringify(value);
    if (json === undefined) {
      return String(value);
    }
    return json.length > 200_000 ? `${json.slice(0, 200_000)}…` : JSON.parse(json);
  } catch {
    return String(value);
  }
}

export const browserUseService = {
  async getSettings() {
    return readSettings();
  },

  async updateSettings(settings: Partial<BrowserUseSettings>) {
    const current = readSettings();
    const nextSettings = {
      enabled: typeof settings.enabled === 'boolean' ? settings.enabled : current.enabled,
    };

    const next = writeSettings(nextSettings);
    if (next.enabled) {
      await this.registerAgentMcp();
    } else if (current.enabled) {
      await this.unregisterAgentMcp();
      await this.stopAllSessions();
    }
    return next;
  },

  async getStatus() {
    const settings = readSettings();
    const readiness = getRuntimeReadiness();
    const available = settings.enabled && readiness.playwrightInstalled && readiness.chromiumInstalled;

    return {
      enabled: settings.enabled,
      runtime: getRuntime(),
      available,
      playwrightInstalled: readiness.playwrightInstalled,
      chromiumInstalled: readiness.chromiumInstalled,
      installInProgress: readiness.installInProgress,
      sessionCount: sessions.size,
      message: available
        ? 'Browser runtime is available.'
        : getSetupMessage(settings, readiness),
    };
  },

  async registerAgentMcp() {
    const { command, args } = getMcpCommand();
    await Promise.all(LEGACY_MCP_SERVER_NAMES.map((name) => removeMcpServerFromAllProviders(name)));
    const results = await providerMcpService.addMcpServerToAllProviders({
      name: MCP_SERVER_NAME,
      scope: 'user',
      transport: 'stdio',
      command,
      args,
      env: {
        CLOUDCLI_BROWSER_USE_MCP_TOKEN: getOrCreateMcpToken(),
        CLOUDCLI_BROWSER_USE_API_URL: getMcpApiUrl(),
      },
    });
    return { name: MCP_SERVER_NAME, command, args, results };
  },

  getMcpToken() {
    return getOrCreateMcpToken();
  },

  async unregisterAgentMcp() {
    const results = (await Promise.all(
      [MCP_SERVER_NAME, ...LEGACY_MCP_SERVER_NAMES].map((name) => removeMcpServerFromAllProviders(name)),
    )).flat();
    return { name: MCP_SERVER_NAME, results };
  },

  async installRuntime() {
    const result = await installRuntime();
    return {
      ...result,
      status: await this.getStatus(),
    };
  },

  async listSessions() {
    await expireStaleSessions();
    return [...sessions.values()]
      .filter((session) => session.ownerId === AGENT_OWNER_ID)
      .map(publicSession);
  },

  async createAgentSession(options?: { profileName?: string | null } & EmulationInput) {
    const settings = readSettings();
    if (!settings.enabled) {
      throw new Error('Browser agent tools are disabled.');
    }

    await expireStaleSessions();
    const profileName = normalizeProfileName(options?.profileName);
    // ethia fork: sessions can start straight in a phone viewport.
    const emulation = resolveEmulation(options || {});

    const now = new Date().toISOString();
    const session: BrowserUseSession = {
      id: randomUUID(),
      ownerId: AGENT_OWNER_ID,
      createdBy: 'agent',
      runtime: getRuntime(),
      status: 'unavailable',
      url: null,
      title: null,
      screenshotDataUrl: null,
      createdAt: now,
      updatedAt: now,
      lastAction: 'create',
      message: null,
      profileName,
      viewport: { width: emulation.width, height: emulation.height },
      emulation,
      cursor: null,
    };

    const activeOwnerSessions = ownerSessions(AGENT_OWNER_ID).filter((item) => item.status === 'ready');
    if (activeOwnerSessions.length >= MAX_SESSIONS_PER_OWNER) {
      throw new Error(`Browser is limited to ${MAX_SESSIONS_PER_OWNER} active agent sessions.`);
    }

    const readiness = getRuntimeReadiness();
    if (!settings.enabled || !readiness.playwrightInstalled || !readiness.chromiumInstalled || !readiness.playwright) {
      session.message = getSetupMessage(settings, readiness);
      sessions.set(session.id, session);
      return publicSession(session);
    }

    const handle = await launchEmulatedContext(readiness.playwright, emulation, profileName);
    session.status = 'ready';
    session.message = 'Browser session is ready.';
    sessions.set(session.id, session);
    handles.set(session.id, handle);
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async listAgentSessions() {
    const settings = readSettings();
    if (!settings.enabled) {
      return [];
    }
    await expireStaleSessions();
    return [...sessions.values()]
      .filter((session) => session.ownerId === AGENT_OWNER_ID)
      .map(publicSession);
  },

  async getAgentSession(sessionId: string) {
    const settings = readSettings();
    if (!settings.enabled) {
      throw new Error('Browser agent tools are disabled.');
    }
    const session = sessions.get(sessionId);
    if (!session || session.ownerId !== AGENT_OWNER_ID) {
      throw new Error('Browser session not found.');
    }
    return session;
  },

  async agentNavigate(sessionId: string, rawUrl: string) {
    await this.getAgentSession(sessionId);
    await expireStaleSessions();

    const session = sessions.get(sessionId);
    if (!session || session.ownerId !== AGENT_OWNER_ID) {
      throw new Error('Browser session not found.');
    }

    if (session.status !== 'ready') {
      throw new Error(session.message || 'Browser session is not available.');
    }

    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }

    const url = normalizeUrl(rawUrl);
    await handle.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    session.lastAction = `navigate:${url}`;
    session.cursor = null;
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentSnapshot(sessionId: string) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    await captureSession(session, handle.page);
    const text = await handle.page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    return {
      session: publicSession(session),
      text: text.slice(0, 30_000),
    };
  },

  async agentClick(sessionId: string, input: { selector?: string; text?: string; x?: number; y?: number }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const point = await getActionPoint(handle.page, input);
    // ethia fork: emulated phones need real touch events — plenty of mobile UIs
    // only bind touchstart/tap handlers.
    const useTouch = session.emulation?.hasTouch === true;

    if (input.selector || input.text) {
      const locator = input.selector
        ? handle.page.locator(input.selector).first()
        : handle.page.getByText(input.text as string, { exact: false }).first();
      if (useTouch) {
        await locator.tap({ timeout: 10_000 });
      } else {
        await locator.click({ timeout: 10_000 });
      }
    } else if (typeof input.x === 'number' && typeof input.y === 'number') {
      if (useTouch) {
        await handle.page.touchscreen.tap(input.x, input.y);
      } else {
        await handle.page.mouse.click(input.x, input.y);
      }
    } else {
      throw new Error('Provide selector, text, or x/y coordinates.');
    }

    session.lastAction = useTouch ? 'tap' : 'click';
    session.cursor = point ? { ...point, actor: 'agent' } : null;
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentType(sessionId: string, input: { selector?: string; text: string; submit?: boolean }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }

    if (input.selector) {
      await handle.page.locator(input.selector).first().fill(input.text, { timeout: 10_000 });
      session.cursor = await getActionPoint(handle.page, input).then((point) => (
        point ? { ...point, actor: 'agent' as const } : null
      ));
    } else {
      await handle.page.keyboard.type(input.text);
    }
    if (input.submit) {
      await handle.page.keyboard.press('Enter');
    }

    session.lastAction = 'type';
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentFillForm(sessionId: string, fields: Array<{ selector: string; value: string }>) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    for (const field of fields) {
      await handle.page.locator(field.selector).first().fill(field.value, { timeout: 10_000 });
    }
    session.lastAction = 'fill_form';
    if (fields[0]) {
      session.cursor = await getActionPoint(handle.page, { selector: fields[0].selector }).then((point) => (
        point ? { ...point, actor: 'agent' as const } : null
      ));
    }
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentPressKey(sessionId: string, key: string) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    await handle.page.keyboard.press(key);
    session.lastAction = `press_key:${key}`;
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentSelectOption(sessionId: string, selector: string, values: string[]) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    await handle.page.locator(selector).first().selectOption(values, { timeout: 10_000 });
    session.lastAction = 'select_option';
    session.cursor = await getActionPoint(handle.page, { selector }).then((point) => (
      point ? { ...point, actor: 'agent' as const } : null
    ));
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentWaitFor(sessionId: string, input: { text?: string; url?: string; timeoutMs?: number }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const timeout = Math.max(250, Math.min(input.timeoutMs || 5_000, 30_000));
    if (input.text) {
      await handle.page.getByText(input.text, { exact: false }).first().waitFor({ timeout });
    } else if (input.url) {
      await handle.page.waitForURL(input.url, { timeout });
    } else {
      await handle.page.waitForTimeout(timeout);
    }
    session.lastAction = 'wait_for';
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentTabs(sessionId: string, input: { action?: 'list' | 'new' | 'select' | 'close'; index?: number; url?: string }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.context || !handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const action = input.action || 'list';
    if (action === 'new') {
      const page = await handle.context.newPage();
      handles.set(sessionId, { ...handle, page });
      if (input.url) {
        await this.agentNavigate(sessionId, input.url);
      }
    } else if (action === 'select') {
      const page = handle.context.pages()[input.index || 0];
      if (!page) {
        throw new Error('Tab not found.');
      }
      handles.set(sessionId, { ...handle, page });
    } else if (action === 'close') {
      const pages = handle.context.pages();
      const page = pages[input.index ?? pages.indexOf(handle.page)];
      if (!page) {
        throw new Error('Tab not found.');
      }
      await page.close();
      handles.set(sessionId, { ...handle, page: handle.context.pages()[0] || await handle.context.newPage() });
    }
    const updatedHandle = handles.get(sessionId);
    await captureSession(session, updatedHandle?.page || handle.page);
    return {
      session: publicSession(session),
      tabs: handle.context.pages().map((page: any, index: number) => ({
        index,
        url: page.url(),
        active: page === (updatedHandle?.page || handle.page),
      })),
    };
  },

  // ethia fork: mobile emulation + DevTools for agent sessions.
  listDevices() {
    return { devices: listPresets() };
  },

  /**
   * Switch the session to another device/viewport. A pure size change is applied
   * in place; anything that lives on the browser context (touch, scale factor,
   * user agent) needs a fresh context, so the current page is reopened there.
   */
  async agentEmulate(sessionId: string, input: EmulationInput) {
    const session = await this.getAgentSession(sessionId);
    return applyEmulation(session, input);
  },

  /** Same switch, driven from the admin Browser tab. */
  async adminEmulate(sessionId: string, input: EmulationInput) {
    const session = sessions.get(sessionId);
    if (!session || session.ownerId !== AGENT_OWNER_ID) {
      throw new Error('Browser session not found.');
    }
    return applyEmulation(session, input);
  },

  /** Console/network buffers for the admin Browser tab. */
  async adminDevtools(sessionId: string, input: DevtoolsQuery = {}) {
    const session = sessions.get(sessionId);
    if (!session || session.ownerId !== AGENT_OWNER_ID) {
      throw new Error('Browser session not found.');
    }
    return readDevtools(sessionId, input);
  },

  async agentDevtools(sessionId: string, input: DevtoolsQuery = {}) {
    await this.getAgentSession(sessionId);
    return readDevtools(sessionId, input);
  },

  async agentEvaluate(sessionId: string, script: string) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const source = String(script || '').trim();
    if (!source) {
      throw new Error('script is required.');
    }

    // Accept both an expression (`document.title`) and a statement body
    // (`const el = ...; return el.offsetWidth;`). Which one it is, is decided by
    // compiling here — the page only ever sees a function that parses.
    const compile = (body: string) => new Function(body) as any;
    let compiled: any;
    try {
      compiled = compile(`return (async () => (${source}))();`);
    } catch {
      try {
        compiled = compile(`return (async () => { ${source} })();`);
      } catch (error: any) {
        throw new Error(`Invalid script: ${error?.message || error}`);
      }
    }

    const value = await handle.page.evaluate(compiled);
    session.lastAction = 'evaluate';
    session.updatedAt = new Date().toISOString();
    return { result: serializeEvaluationResult(value) };
  },

  async agentGetHtml(sessionId: string, input: { selector?: string; maxLength?: number } = {}) {
    await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const maxLength = Math.max(1_000, Math.min(Number(input.maxLength) || 50_000, 200_000));
    const html = input.selector
      ? await handle.page.locator(input.selector).first().evaluate((node: any) => node.outerHTML, undefined, { timeout: 10_000 })
      : await handle.page.content();
    const text = String(html || '');
    return {
      selector: input.selector || null,
      truncated: text.length > maxLength,
      html: text.slice(0, maxLength),
    };
  },

  // ethia fork: admin-driven input into a live session (interactive Browser tab).
  // Mounted behind authenticateToken + requireAdmin; agents keep using the MCP
  // tools above. No enabled-check on purpose — mirrors stopSession/deleteSession.
  async adminInput(sessionId: string, input: {
    action?: 'click' | 'type' | 'key' | 'scroll' | 'navigate' | 'refresh';
    x?: number;
    y?: number;
    button?: 'left' | 'right' | 'middle';
    text?: string;
    key?: string;
    deltaY?: number;
    url?: string;
    capture?: boolean;
  }) {
    const session = sessions.get(sessionId);
    if (!session || session.ownerId !== AGENT_OWNER_ID) {
      throw new Error('Browser session not found.');
    }
    if (session.status !== 'ready') {
      throw new Error(session.message || 'Browser session is not available.');
    }
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }

    const page = handle.page;
    const action = input.action || 'refresh';
    switch (action) {
      case 'click': {
        if (typeof input.x !== 'number' || typeof input.y !== 'number') {
          throw new Error('Click requires x/y coordinates.');
        }
        if (session.emulation?.hasTouch && (input.button || 'left') === 'left') {
          await page.touchscreen.tap(input.x, input.y);
        } else {
          await page.mouse.click(input.x, input.y, { button: input.button || 'left' });
        }
        session.cursor = { x: Math.round(input.x), y: Math.round(input.y), actor: 'agent' };
        break;
      }
      case 'type': {
        if (!input.text) {
          throw new Error('Type requires text.');
        }
        await page.keyboard.type(String(input.text).slice(0, 2000));
        break;
      }
      case 'key': {
        if (!input.key) {
          throw new Error('Key press requires a key.');
        }
        await page.keyboard.press(String(input.key).slice(0, 40));
        break;
      }
      case 'scroll': {
        const deltaY = Math.max(-5000, Math.min(5000, Number(input.deltaY) || 0));
        await page.mouse.wheel(0, deltaY);
        break;
      }
      case 'navigate': {
        await page.goto(normalizeUrl(input.url || ''), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        session.cursor = null;
        break;
      }
      case 'refresh':
        break;
      default:
        throw new Error('Unsupported input action.');
    }

    session.lastAction = `user:${action}`;
    if (input.capture === false) {
      session.updatedAt = new Date().toISOString();
    } else {
      await captureSession(session, page);
    }
    return publicSession(session);
  },

  async stopSession(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session || session.ownerId !== AGENT_OWNER_ID) {
      return { stopped: false };
    }

    await closeHandle(sessionId);

    session.status = 'stopped';
    session.updatedAt = new Date().toISOString();
    session.lastAction = 'stop';
    session.message = 'Browser session stopped. Create a new session to continue browsing.';
    return { stopped: true, session: publicSession(session) };
  },

  async deleteSession(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session || session.ownerId !== AGENT_OWNER_ID) {
      return { deleted: false };
    }

    await closeHandle(sessionId);
    sessions.delete(sessionId);
    return { deleted: true, sessionId };
  },

  async agentStopSession(sessionId: string) {
    await this.getAgentSession(sessionId);
    return this.stopSession(sessionId);
  },

  async stopAllSessions() {
    await Promise.all([...sessions.keys()].map(async (sessionId) => {
      await closeHandle(sessionId);
      const session = sessions.get(sessionId);
      if (session) {
        session.status = 'stopped';
        session.updatedAt = new Date().toISOString();
        session.lastAction = 'shutdown';
        session.message = 'Browser session stopped during server shutdown.';
      }
    }));
  },
};

process.once('beforeExit', () => {
  void browserUseService.stopAllSessions();
});

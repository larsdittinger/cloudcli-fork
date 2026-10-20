// Claude runs of isolated projects: the SDK options that send the CLI process into the sandbox (daemon spawn as
// the project uid) with an allowlisted env, the project's own settings and only the sandbox's CloudCLI MCP servers.
// The Claude runtime calls applySandboxOptions for every run; anything that goes wrong for an isolated project is
// an error, never a local spawn.
import path from 'node:path';

import { daemonClient, SANDBOX_DOWN_TEXT, type SandboxProcess } from '@/modules/isolation/daemon-client.js';
import { isolationConfig } from '@/modules/isolation/isolation.config.js';
import { isIsolatedPath, isolationDb, type IsolatedProject } from '@/modules/isolation/isolation.db.js';
import { isProviderSessionIdFree } from '@/modules/isolation/isolation-transcripts.js';
import { runTokens, type RunChannelContext } from '@/modules/isolation/run-tokens.js';

/** The daemon's loopback forward to the app's main.sock (Claude proxy, MCP), as seen inside the sandbox. */
export const SANDBOX_APP_URL = 'http://127.0.0.1:7701';
/** The daemon's egress proxy, as seen inside the sandbox. */
export const SANDBOX_PROXY_HOST = '127.0.0.1:7702';
/** Where the sandbox image keeps channels-mcp.js and tasks-mcp.js (the app passes the path; it never reads it). */
export const DEFAULT_SANDBOX_MCP_DIR = '/opt/cloudcli-sandbox/mcp';
const DEFAULT_SANDBOX_PATH = '/usr/local/bin:/usr/bin:/bin';
/** Same value the runtime gives local runs (see CLI_BG_WAIT_CEILING_MS there): background agents run unbounded. */
const DEFAULT_BG_WAIT_CEILING_MS = '0';

export const ISOLATED_CLAUDE_ONLY_TEXT = 'Izolovaný projekt podporuje jen Claude.';
const NOT_A_PROJECT_TEXT = 'Tato cesta patří do izolované oblasti, ale nepatří k izolovanému projektu — běh se nespustí.';

export type SandboxRunContext = {
  /** The session's project. */
  projectPath?: string | null;
  sessionId?: string | null;
  /** Set by the Channels dispatcher (never by a client): narrows MCP to this thread, tells tools the sender. */
  channelContext?: RunChannelContext | null;
  /** Set by the agent-tasks engine: narrows MCP to this task. */
  taskId?: number | null;
};

export type SandboxRun = {
  project: IsolatedProject;
  sdkOptions: Record<string, any>;
  /** Revokes the run token. Idempotent; called on process exit and when the run ends. */
  release(): void;
  /** The sandbox's own reason when the process failed (rejected spawn, daemon down), for the chat. */
  error(): string | null;
  /** Whether a later turn may be fed into this process: its token and env were minted for one context. */
  accepts(next: Pick<SandboxRunContext, 'channelContext' | 'taskId'>): boolean;
  /**
   * Whether the session id the sandboxed CLI reports may be recorded for the app session `appSessionId`: it must
   * not name a session of another project (the same rule as for transcripts in isolated homes).
   */
  acceptsProviderSessionId(providerSessionId: string, appSessionId?: string | null): boolean;
};

export type SandboxEnvOptions = {
  /** False for processes that are not Claude (schedule scripts, terminal): no Claude API keys. Default true. */
  claude?: boolean;
  /** CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS for Claude processes. */
  bgWaitCeilingMs?: string;
};

export function sandboxMcpDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLOUDCLI_SANDBOX_MCP_DIR?.trim() || DEFAULT_SANDBOX_MCP_DIR;
}

/**
 * The complete environment of a process in the sandbox. An allowlist: nothing of the app's own env goes in.
 * `extra` adds run-specific values (Channels sender/message).
 */
export function buildSandboxEnv(
  project: IsolatedProject,
  runToken: string,
  extra: Record<string, string> = {},
  options: SandboxEnvOptions = {},
): Record<string, string> {
  const proxy = `http://${project.projectId}:${project.proxySecret}@${SANDBOX_PROXY_HOST}`;
  const env: Record<string, string> = {
    PATH: process.env.CLOUDCLI_SANDBOX_PATH?.trim() || DEFAULT_SANDBOX_PATH,
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    HOME: project.homeDir,
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    NO_PROXY: '127.0.0.1,localhost',
    // curl, wget, pip and git read the lowercase names (curl only these for plain http).
    https_proxy: proxy,
    http_proxy: proxy,
    no_proxy: '127.0.0.1,localhost',
    NODE_USE_ENV_PROXY: '1',
    CLOUDCLI_RUN_TOKEN: runToken,
  };
  if (options.claude !== false) {
    Object.assign(env, {
      ANTHROPIC_BASE_URL: `${SANDBOX_APP_URL}/anthropic`,
      // The proxy in the app swaps this run token for the real Claude login.
      CLAUDE_CODE_OAUTH_TOKEN: runToken,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: options.bgWaitCeilingMs ?? DEFAULT_BG_WAIT_CEILING_MS,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      // The owner's claude.ai connectors (Gmail, Drive, ClickUp…) must never load for an isolated agent.
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    });
  }
  return { ...env, ...extra };
}

/**
 * The CloudCLI MCP servers an isolated agent gets, run inside the sandbox from its image. The CLI receives them
 * as `--mcp-config` on its command line, which other uids in the sandbox can read in /proc — so the run token is
 * only referenced (`${CLOUDCLI_RUN_TOKEN}`) and the CLI expands it from its own environment.
 */
function sandboxMcpServers(project: IsolatedProject): Record<string, unknown> {
  const dir = sandboxMcpDir();
  const servers: Record<string, unknown> = {};
  const server = (kind: 'channels' | 'tasks') => ({
    type: 'stdio',
    command: 'node',
    args: [path.posix.join(dir, `${kind}-mcp.js`)],
    env: {
      [`CLOUDCLI_${kind.toUpperCase()}_API_URL`]: `${SANDBOX_APP_URL}/api/${kind}-mcp`,
      [`CLOUDCLI_${kind.toUpperCase()}_MCP_TOKEN`]: '${CLOUDCLI_RUN_TOKEN}',
    },
  });
  if (project.tools.channels) servers['cloudcli-channels'] = server('channels');
  if (project.tools.tasks) servers['cloudcli-tasks'] = server('tasks');
  return servers;
}

/**
 * What the CLI gets in the sandbox: its flags only. The SDK spawns either `<native binary> [executableArgs]
 * <flags>` or `<node|bun> [executableArgs] <cli.js> <flags>`; the daemon runs its own `claude`, so everything
 * before the flags goes. The SDK always starts its flags with `--output-format stream-json`.
 */
export function sandboxCliArgs(args: readonly string[]): string[] {
  const start = args.findIndex((arg, index) => arg === '--output-format' && args[index + 1] === 'stream-json');
  if (start < 0) throw new Error(`${SANDBOX_DOWN_TEXT} (unexpected CLI arguments: no --output-format stream-json)`);
  return args.slice(start);
}

function cleanChannelContext(value: unknown): RunChannelContext | undefined {
  const context = value as Partial<RunChannelContext> | null | undefined;
  if (!context || typeof context !== 'object') return undefined;
  const { messageId, threadKey, sender } = context;
  if (typeof messageId !== 'string' || typeof threadKey !== 'string' || typeof sender !== 'string') return undefined;
  return { messageId, threadKey, sender };
}

const cleanTaskId = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);

const sameContext = (a?: RunChannelContext, b?: RunChannelContext) =>
  (!a && !b) || Boolean(a && b && a.messageId === b.messageId && a.threadKey === b.threadKey && a.sender === b.sender);

/**
 * Turns the SDK options of a run into a sandbox run when the project is isolated. Returns null for every other
 * project (options untouched). Throws when the project is isolated but cannot run in the sandbox.
 */
export function applySandboxOptions(sdkOptions: Record<string, any>, ctx: SandboxRunContext): SandboxRun | null {
  const projectPath = typeof ctx.projectPath === 'string' && ctx.projectPath ? ctx.projectPath : null;
  const requestedCwd = typeof sdkOptions.cwd === 'string' && sdkOptions.cwd ? sdkOptions.cwd : null;
  const candidates = [projectPath, requestedCwd].filter((value): value is string => Boolean(value));
  if (!candidates.some((candidate) => isIsolatedPath(candidate))) return null;

  const config = isolationConfig();
  if (!config.available) throw new Error(`${SANDBOX_DOWN_TEXT} (${config.reason ?? 'isolation is not configured'})`);

  const project = isolationDb.getByPath(projectPath ?? requestedCwd!);
  if (!project) throw new Error(NOT_A_PROJECT_TEXT);
  const cwd = requestedCwd ?? project.projectPath;
  // The working directory must lie in the same isolated project; an isolated session never runs elsewhere.
  if (isolationDb.getByPath(cwd)?.projectId !== project.projectId) {
    throw new Error(`Izolovaný projekt „${project.name}“ může běžet jen ve svém adresáři (${project.projectPath}).`);
  }
  if (!project.homeDir) throw new Error(`${SANDBOX_DOWN_TEXT} (CLOUDCLI_ISOLATED_HOMES is not set)`);

  const channel = cleanChannelContext(ctx.channelContext);
  const taskId = cleanTaskId(ctx.taskId);
  const runToken = runTokens.mint({
    projectId: project.projectId,
    sessionId: typeof ctx.sessionId === 'string' ? ctx.sessionId : '',
    purpose: 'claude',
    ...(channel ? { channel } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
  });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    runTokens.revoke(runToken);
  };
  let lastError: string | null = null;

  const env = buildSandboxEnv(
    project,
    runToken,
    channel ? { CLOUDCLI_CHANNEL_SENDER: channel.sender, CLOUDCLI_CHANNEL_MESSAGE_ID: channel.messageId } : {},
    { bgWaitCeilingMs: typeof sdkOptions.env?.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS === 'string' ? sdkOptions.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS : undefined },
  );

  sdkOptions.cwd = cwd;
  sdkOptions.env = env;
  delete sdkOptions.pathToClaudeCodeExecutable;
  // User settings would be the sandbox home's anyway; never the app's.
  sdkOptions.settingSources = ['project', 'local'];
  // Replaces whatever the app's ~/.claude.json listed. The project's .mcp.json is read by the CLI itself.
  sdkOptions.mcpServers = sandboxMcpServers(project);

  sdkOptions.spawnClaudeCodeProcess = (spawnOptions: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal?: AbortSignal;
  }): SandboxProcess => {
    let args: string[];
    try {
      args = sandboxCliArgs(spawnOptions.args);
    } catch (error) {
      lastError = (error as Error).message;
      release();
      throw error;
    }
    // The SDK marks its process; that one value is harmless and the CLI reports it.
    const entrypoint = spawnOptions.env?.CLAUDE_CODE_ENTRYPOINT;
    const proc = daemonClient.spawn({
      kind: 'claude',
      projectId: project.projectId,
      uid: project.uid,
      projectDir: project.projectPath,
      homeDir: project.homeDir,
      cwd: spawnOptions.cwd || cwd,
      args,
      env: typeof entrypoint === 'string' && /^[\w.-]{1,64}$/.test(entrypoint) ? { ...env, CLAUDE_CODE_ENTRYPOINT: entrypoint } : { ...env },
    });
    // Synchronously: a failed connect is reported on the next tick.
    proc.on('error', (error: Error) => {
      lastError = error.message;
    });
    proc.once('exit', release);
    const signal = spawnOptions.signal;
    if (signal) {
      const onAbort = () => proc.kill('SIGTERM');
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener('abort', onAbort, { once: true });
        proc.once('exit', () => signal.removeEventListener('abort', onAbort));
      }
    }
    return proc;
  };

  return {
    project,
    sdkOptions,
    release,
    error: () => lastError,
    accepts: (next) => sameContext(channel, cleanChannelContext(next.channelContext)) && taskId === cleanTaskId(next.taskId),
    acceptsProviderSessionId: (providerSessionId, appSessionId) =>
      isProviderSessionIdFree(project.projectId, providerSessionId, appSessionId),
  };
}

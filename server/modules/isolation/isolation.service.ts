// Isolation settings, daemon sync and the self-check, used by the admin routes and at startup.
import { parseAllowlist, type AllowlistError } from '@/modules/isolation/daemon/allowlist.js';
import { resolveClaudeToken } from '@/modules/isolation/claude-proxy.js';
import { daemonClient, type BlockedEntry, type DaemonStatus, type SelfCheckResult } from '@/modules/isolation/daemon-client.js';
import { isolationConfig, mainSocketPath } from '@/modules/isolation/isolation.config.js';
import { isolationDb, type IsolatedProject, type IsolationTools } from '@/modules/isolation/isolation.db.js';
import { runTokens } from '@/modules/isolation/run-tokens.js';
import { startSandboxApiServer, type SandboxApiServer } from '@/modules/isolation/sandbox-api.server.js';
import { AppError } from '@/shared/utils.js';

const MAX_ALLOWLIST_LINES = 500;
const MAX_ALLOWLIST_LINE_LENGTH = 300;
const RESYNC_INTERVAL_MS = 30_000;

/** What the browser sees of an isolated project: no proxy secret. */
export type PublicIsolatedProject = Omit<IsolatedProject, 'proxySecret'>;

export type DaemonSync = { ok: true } | { ok: false; error: string };

export class AllowlistValidationError extends Error {
  constructor(public readonly errors: AllowlistError[]) {
    super(`Invalid allowlist: ${errors.map((error) => `line ${error.line}: ${error.message}`).join('; ')}`);
  }
}

const toPublic = ({ proxySecret: _secret, ...project }: IsolatedProject): PublicIsolatedProject => project;

function requireIsolated(projectId: string): IsolatedProject {
  const project = isolationDb.getById(projectId);
  if (!project) throw new AppError('Project is not isolated.', { code: 'NOT_ISOLATED', statusCode: 404 });
  return project;
}

function requireAvailable(): void {
  const config = isolationConfig();
  if (!config.available) throw new AppError(config.reason ?? 'Isolation is not set up on this instance.', { code: 'ISOLATION_UNAVAILABLE', statusCode: 409 });
}

/** Allowlist from the request: string[] or one textarea string. Returns the lines to store or throws per-line errors. */
export function readAllowlist(raw: unknown): string[] {
  const lines = typeof raw === 'string' ? raw.split(/\r?\n/) : raw;
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== 'string')) {
    throw new AllowlistValidationError([{ line: 0, message: 'allowlist must be a list of lines' }]);
  }
  if (lines.length > MAX_ALLOWLIST_LINES) {
    throw new AllowlistValidationError([{ line: MAX_ALLOWLIST_LINES + 1, message: `At most ${MAX_ALLOWLIST_LINES} lines` }]);
  }
  const tooLong = lines.flatMap((line, index) => (line.length > MAX_ALLOWLIST_LINE_LENGTH ? [{ line: index + 1, message: 'Line is too long' }] : []));
  const { errors } = parseAllowlist(lines as string[]);
  const all = [...tooLong, ...errors.filter((error) => !tooLong.some((long) => long.line === error.line))].sort((a, b) => a.line - b.line);
  if (all.length) throw new AllowlistValidationError(all);
  return (lines as string[]).map((line) => line.trim()).filter(Boolean);
}

function readTools(raw: unknown): Partial<IsolationTools> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('tools must be an object.', { code: 'INVALID_REQUEST', statusCode: 400 });
  }
  const tools: Partial<IsolationTools> = {};
  for (const key of ['channels', 'tasks'] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw new AppError(`tools.${key} must be true or false.`, { code: 'INVALID_REQUEST', statusCode: 400 });
    tools[key] = value;
  }
  return tools;
}

async function syncProject(project: IsolatedProject): Promise<DaemonSync> {
  if (!isolationConfig().available) return { ok: false, error: isolationConfig().reason ?? 'Isolation is not set up.' };
  try {
    await daemonClient.putProject(project);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export const isolationService = {
  async status(): Promise<{
    available: boolean;
    reason?: string;
    isolatedRoot?: string;
    daemon: DaemonStatus | null;
    claudeLogin: 'setup-token' | 'credentials' | 'missing';
    isolatedProjects: number;
  }> {
    const config = isolationConfig();
    const claude = await resolveClaudeToken().catch(() => null);
    const base = { claudeLogin: claude?.source ?? 'missing', isolatedProjects: isolationDb.listIsolated().length } as const;
    if (!config.available) return { available: false, reason: config.reason, daemon: null, ...base };
    return { available: true, isolatedRoot: config.isolatedRoot, daemon: await daemonClient.status(), ...base };
  },

  getProject(projectId: string): PublicIsolatedProject {
    return toPublic(requireIsolated(projectId));
  },

  async updateProject(projectId: string, body: { allowlist?: unknown; tools?: unknown }): Promise<PublicIsolatedProject & { daemonSync: DaemonSync }> {
    requireIsolated(projectId);
    const allowlist = body.allowlist === undefined ? undefined : readAllowlist(body.allowlist);
    const tools = readTools(body.tools);
    const saved = isolationDb.updateSettings(projectId, { allowlist, tools });
    return { ...toPublic(saved), daemonSync: await syncProject(saved) };
  },

  async blocked(projectId: string): Promise<BlockedEntry[]> {
    requireIsolated(projectId);
    requireAvailable();
    try {
      return await daemonClient.blocked(projectId);
    } catch (error) {
      throw new AppError((error as Error).message, { code: 'SANDBOX_UNAVAILABLE', statusCode: 502 });
    }
  },

  /** Runs the probe script in the sandbox as the project uid, with a run token that dies right after. */
  async selfCheck(projectId: string): Promise<SelfCheckResult> {
    const project = requireIsolated(projectId);
    requireAvailable();
    const sync = await syncProject(project); // the daemon may have lost the project; the check needs it
    if (!sync.ok) throw new AppError(sync.error, { code: 'SANDBOX_UNAVAILABLE', statusCode: 502 });
    const token = runTokens.mint({ projectId, sessionId: '', purpose: 'self-check' });
    try {
      return await daemonClient.selfCheck(projectId, token, project.projectPath);
    } catch (error) {
      throw new AppError((error as Error).message, { code: 'SANDBOX_UNAVAILABLE', statusCode: 502 });
    } finally {
      runTokens.revoke(token);
    }
  },

  /**
   * Makes a project isolated end to end, in the order the daemon requires: DB (uid, secret) → push config →
   * prepare ownership and home. Used by the copy-as-isolated flow.
   */
  async provision(projectId: string): Promise<{ project: IsolatedProject; warnings: string[] }> {
    requireAvailable();
    const project = isolationDb.markIsolated(projectId, isolationDb.allocateUid());
    await daemonClient.putProject(project);
    const { warnings } = await daemonClient.prepare(project);
    return { project, warnings };
  },

  /** Pushes every isolated project to the daemon (it may have lost its state). */
  async syncAll(): Promise<{ ok: number; failed: Array<{ projectId: string; error: string }> }> {
    const failed: Array<{ projectId: string; error: string }> = [];
    let ok = 0;
    for (const project of isolationDb.listIsolated()) {
      const result = await syncProject(project);
      if (result.ok) ok += 1;
      else failed.push({ projectId: project.projectId, error: result.error });
    }
    return { ok, failed };
  },
};

let sandboxApi: SandboxApiServer | null = null;
let resyncTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts main.sock and pushes all isolated projects to the daemon; afterwards re-pushes whenever the daemon
 * comes back or reports fewer projects than the app has. No-op when isolation is not set up.
 */
export async function initializeIsolation(): Promise<void> {
  const config = isolationConfig();
  if (!config.available) {
    console.log(`[Isolation] ${config.reason}`);
    return;
  }
  sandboxApi = await startSandboxApiServer(mainSocketPath(config));
  console.log(`[Isolation] sandbox API listening on ${sandboxApi.socketPath}`);

  let synced = false;
  const resync = async () => {
    const status = await daemonClient.status();
    if (!status.running) {
      if (synced) console.warn(`[Isolation] sandbox daemon unreachable: ${status.reason}`);
      synced = false;
      return;
    }
    const expected = isolationDb.listIsolated().length;
    if (synced && (status.projects ?? 0) >= expected) return;
    const result = await isolationService.syncAll();
    synced = result.failed.length === 0;
    for (const failure of result.failed) console.warn(`[Isolation] could not push project ${failure.projectId}: ${failure.error}`);
  };
  await resync().catch((error: unknown) => console.warn(`[Isolation] initial sync failed: ${(error as Error).message}`));
  resyncTimer = setInterval(() => void resync().catch(() => undefined), RESYNC_INTERVAL_MS);
  resyncTimer.unref?.();
}

export async function closeIsolation(): Promise<void> {
  if (resyncTimer) clearInterval(resyncTimer);
  resyncTimer = null;
  await sandboxApi?.close();
  sandboxApi = null;
}

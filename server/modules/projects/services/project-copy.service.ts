// Copy of a project directory into a new project, optionally as an isolated one.
// Runs as a background job (async fs, progress in bytes) and removes the partial target on any failure.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { projectsDb } from '@/modules/database/index.js';
import {
  daemonClient,
  isolatedAreaOf,
  isolatedFs,
  isolationConfig,
  isolationDb,
  isolationService,
  SANDBOX_DOWN_TEXT,
} from '@/modules/isolation/index.js';
import type { ProjectRepositoryRow, WorkspacePathValidationResult } from '@/shared/types.js';
import { AppError, normalizeProjectPath, validateWorkspacePath, WORKSPACES_ROOT } from '@/shared/utils.js';

export type CopyInput = {
  name: string;
  isolated: boolean;
  excludeSecretFiles: string[];
  carryMcp: string[];
};

export type CopyDependencies = {
  /** `~/.claude.json` of the app (user-scope MCP servers per project). */
  claudeJsonPath?: string;
  /** Called after every copied entry (relative path); a throw fails the copy. Tests only. */
  afterEntry?: (rel: string) => void | Promise<void>;
  /** Where a plain copy of an isolated project goes (default `WORKSPACES_ROOT`). */
  workspacesRoot?: string;
  /** Workspace path check; tests replace it (the temp directories sit under forbidden system paths on macOS). */
  validatePath?: (candidate: string) => Promise<WorkspacePathValidationResult>;
};

export type CopiedProject = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  customName: string | null;
  isArchived: boolean;
  isStarred: boolean;
  sessions: [];
  sessionMeta: { hasMore: false; total: 0 };
};

export type CopyPreview = {
  suggestedName: string;
  sizeBytes: number;
  fileCount: number;
  secretFiles: string[];
  userScopeMcp: Array<{ name: string; hasSecrets: boolean }>;
  isolationAvailable: boolean;
};

export type CopyJobView = {
  jobId: string;
  copiedBytes: number;
  totalBytes: number | null;
  done: boolean;
  error?: string;
  project?: CopiedProject;
  warnings: string[];
};

type McpServers = Record<string, Record<string, unknown>>;

const MAX_DEPTH = 256;
const MAX_JSON_BYTES = 1024 * 1024;
const JOB_KEEP_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------------------------------------------
// Names

/** ASCII, no diacritics, only [a-z0-9_-]; never empty. */
export function slugifyProjectName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return slug.slice(0, 80) || 'projekt';
}

const toPosix = (rel: string) => rel.split(path.sep).join('/');

// ---------------------------------------------------------------------------------------------------------------
// Reading the source (plain, or no-follow for an isolated project)

type EntryKind = 'dir' | 'file' | 'symlink' | 'other';
type SourceEntry = { name: string; kind: EntryKind; size: number; mode: number };

type SourceReader = {
  root: string;
  list(rel: string): Promise<SourceEntry[]>;
  readlink(rel: string): Promise<string>;
  readText(rel: string, maxBytes: number): Promise<string>;
  /** Copies a regular file to `destination` (new file), reporting bytes as they go. */
  copyFile(rel: string, destination: string, mode: number, onBytes: (bytes: number) => void): Promise<void>;
};

const kindOf = (stats: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): EntryKind =>
  stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : stats.isSymbolicLink() ? 'symlink' : 'other';

function plainReader(root: string): SourceReader {
  const at = (rel: string) => path.join(root, rel);
  return {
    root,
    async list(rel) {
      const names = await fsp.readdir(at(rel));
      const entries: SourceEntry[] = [];
      for (const name of names) {
        const stats = await fsp.lstat(path.join(at(rel), name));
        entries.push({ name, kind: kindOf(stats), size: stats.size, mode: stats.mode & 0o777 });
      }
      return entries;
    },
    readlink: (rel) => fsp.readlink(at(rel)),
    async readText(rel, maxBytes) {
      const handle = await fsp.open(at(rel), 'r');
      try {
        const { size } = await handle.stat();
        if (size > maxBytes) throw new AppError(`${rel} is too large.`, { code: 'FILE_TOO_LARGE', statusCode: 413 });
        return await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    },
    async copyFile(rel, destination, mode, onBytes) {
      await fsp.copyFile(at(rel), destination, fs.constants.COPYFILE_EXCL);
      await fsp.chmod(destination, mode);
      onBytes((await fsp.stat(destination)).size);
    },
  };
}

/** An isolated project's tree is agent-controlled: every component is opened without following symlinks. */
function isolatedReader(root: string): SourceReader {
  const at = (rel: string) => path.join(root, rel);
  return {
    root,
    async list(rel) {
      const entries: SourceEntry[] = [];
      for await (const dirent of isolatedFs.listDirectory(at(rel))) {
        const kind = kindOf(dirent);
        let size = 0;
        let mode = 0o644;
        if (kind === 'file' || kind === 'dir') {
          const stats = await isolatedFs.lstat(path.join(at(rel), dirent.name));
          size = stats.size;
          mode = stats.mode & 0o777;
        }
        entries.push({ name: dirent.name, kind, size, mode });
      }
      return entries;
    },
    readlink: (rel) => fsp.readlink(at(rel)),
    async readText(rel, maxBytes) {
      return (await isolatedFs.readText(at(rel), maxBytes)).toString('utf8');
    },
    async copyFile(rel, destination, mode, onBytes) {
      const count = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          onBytes(chunk.length);
          callback(null, chunk);
        },
      });
      const out = fs.createWriteStream(destination, { flags: 'wx', mode });
      await pipeline(isolatedFs.createReadStream(at(rel)) as Readable, count, out);
      await fsp.chmod(destination, mode);
    },
  };
}

function readerFor(sourcePath: string): SourceReader {
  return isolatedAreaOf(sourcePath) ? isolatedReader(sourcePath) : plainReader(sourcePath);
}

// ---------------------------------------------------------------------------------------------------------------
// Walking

type Visitor = {
  /** Return false to skip the directory's contents. */
  dir?(rel: string): Promise<void | boolean>;
  file?(rel: string, entry: SourceEntry): Promise<void>;
  symlink?(rel: string, entry: SourceEntry): Promise<void>;
  other?(rel: string, entry: SourceEntry): Promise<void>;
};

async function walk(reader: SourceReader, visitor: Visitor, isCancelled: () => boolean, rel = '', depth = 0): Promise<void> {
  if (depth > MAX_DEPTH) throw new AppError(`${rel} nests too deep to copy.`, { code: 'TREE_TOO_DEEP', statusCode: 400 });
  const entries = await reader.list(rel);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (isCancelled()) throw new AppError('Copy was cancelled.', { code: 'COPY_CANCELLED', statusCode: 409 });
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.kind === 'dir') {
      if ((await visitor.dir?.(childRel)) === false) continue;
      await walk(reader, visitor, isCancelled, childRel, depth + 1);
    } else if (entry.kind === 'file') await visitor.file?.(childRel, entry);
    else if (entry.kind === 'symlink') await visitor.symlink?.(childRel, entry);
    else await visitor.other?.(childRel, entry);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Secrets and MCP servers

const SSH_PRIVATE_KEYS = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);

const isSecretName = (name: string) => {
  const lower = name.toLowerCase();
  const bare = lower.replace(/^\./, '');
  return lower.startsWith('.env') || lower.endsWith('.pem') || lower.endsWith('.key')
    || (bare.startsWith('credentials') && bare.endsWith('.json')) || SSH_PRIVATE_KEYS.has(lower);
};

const hasNonEmptyObject = (value: unknown) => Boolean(value) && typeof value === 'object' && Object.keys(value as object).length > 0;

const serverHasSecrets = (server: Record<string, unknown>) => hasNonEmptyObject(server.env) || hasNonEmptyObject(server.headers);

async function mcpJsonHasEnv(reader: SourceReader, rel: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await reader.readText(rel, MAX_JSON_BYTES)) as { mcpServers?: McpServers };
    return Object.values(parsed.mcpServers ?? {}).some((server) => hasNonEmptyObject(server?.env));
  } catch {
    return false;
  }
}

function defaultClaudeJson(deps: CopyDependencies): string {
  return deps.claudeJsonPath ?? path.join(os.homedir(), '.claude.json');
}

async function readClaudeJson(file: string): Promise<Record<string, any>> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, any>) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function userScopeMcpServers(sourcePath: string, deps: CopyDependencies): Promise<McpServers> {
  const config = await readClaudeJson(defaultClaudeJson(deps)).catch((): Record<string, any> => ({}));
  const projects = (config.projects ?? {}) as Record<string, { mcpServers?: McpServers }>;
  const wanted = normalizeProjectPath(sourcePath);
  const key = Object.keys(projects).find((candidate) => normalizeProjectPath(candidate) === wanted);
  const servers = key ? projects[key]?.mcpServers : undefined;
  return servers && typeof servers === 'object' ? servers : {};
}

// ---------------------------------------------------------------------------------------------------------------
// Preview

function requireSource(projectId: string) {
  const row = projectsDb.getProjectById(projectId);
  if (!row) throw new AppError('Project not found.', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  return row;
}

export async function previewCopy(projectId: string, deps: CopyDependencies = {}): Promise<CopyPreview> {
  const row = requireSource(projectId);
  assertSourceHoldsNoIsolationArea(row.project_path, isolatedAreaOf(row.project_path) !== null);
  const reader = readerFor(row.project_path);
  let sizeBytes = 0;
  let fileCount = 0;
  const secretFiles: string[] = [];
  await walk(reader, {
    async file(rel, entry) {
      sizeBytes += entry.size;
      fileCount += 1;
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      if (isSecretName(name) || (name === '.mcp.json' && (await mcpJsonHasEnv(reader, rel)))) secretFiles.push(rel);
    },
  }, () => false);
  const servers = await userScopeMcpServers(row.project_path, deps);
  const base = row.custom_project_name?.trim() || path.basename(row.project_path);
  return {
    suggestedName: `${base} (kopie)`,
    sizeBytes,
    fileCount,
    secretFiles,
    userScopeMcp: Object.entries(servers).map(([name, server]) => ({ name, hasSecrets: serverHasSecrets(server ?? {}) })),
    isolationAvailable: isolationConfig().available,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs

type Job = {
  view: CopyJobView;
  cancelled: boolean;
  finished: Promise<void>;
};

const jobs = new Map<string, Job>();

export function getCopyJob(jobId: string): CopyJobView | null {
  const job = jobs.get(jobId);
  return job ? { ...job.view, warnings: [...job.view.warnings] } : null;
}

export async function waitForCopyJob(jobId: string): Promise<void> {
  await jobs.get(jobId)?.finished;
}

export function cancelCopyJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job || job.view.done) return false;
  job.cancelled = true;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Start

function normalizeInput(raw: CopyInput): CopyInput {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 120) throw new AppError('A project name (up to 120 characters) is required.', { code: 'INVALID_NAME', statusCode: 400 });
  const list = (value: unknown, field: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new AppError(`${field} must be a list of strings.`, { code: 'INVALID_REQUEST', statusCode: 400 });
    }
    return value as string[];
  };
  return {
    name,
    isolated: raw.isolated === true,
    excludeSecretFiles: list(raw.excludeSecretFiles, 'excludeSecretFiles').map((rel) => path.posix.normalize(rel.replace(/\\/g, '/'))),
    carryMcp: list(raw.carryMcp, 'carryMcp'),
  };
}

/** An isolated target must be a direct child of the isolated root (validateWorkspacePath only knows WORKSPACES_ROOT). */
function isolatedTargetCheck(root: string): NonNullable<CopyDependencies['validatePath']> {
  return async (candidate) => {
    const resolved = path.resolve(candidate);
    if (path.dirname(resolved) !== path.resolve(root) || !/^[a-z0-9_-]+$/.test(path.basename(resolved))) {
      return { valid: false, error: `An isolated copy must be a direct child of ${root}` };
    }
    return { valid: true, resolvedPath: resolved };
  };
}

/**
 * A plain source that contains the isolated root, the homes or the isolation dir would be walked with the
 * symlink-following reader into agent-controlled trees (and into its own output).
 */
function assertSourceHoldsNoIsolationArea(sourcePath: string, sourceIsolated: boolean): void {
  if (sourceIsolated) return;
  const config = isolationConfig();
  const areas = [config.isolatedRoot, config.isolatedHomes, config.isolationDir];
  for (const project of isolationDb.listIsolated()) areas.push(project.projectPath, project.homeDir);
  const forms = (p: string) => {
    const resolved = path.resolve(p);
    try {
      return [resolved, fs.realpathSync(resolved)];
    } catch {
      return [resolved];
    }
  };
  const sources = forms(sourcePath);
  for (const area of areas.filter(Boolean)) {
    if (forms(area).some((areaPath) => sources.some((source) => isInside(areaPath, source)))) {
      throw new AppError('This project contains isolated projects or their data and cannot be copied as a whole.', { code: 'SOURCE_CONTAINS_ISOLATION_AREA', statusCode: 400 });
    }
  }
}

/** Reserves `<parent>/<slug>[-n]` by creating it (mkdir is atomic, so two copies never share a directory). */
async function reserveTarget(parent: string, slug: string, validate: NonNullable<CopyDependencies['validatePath']>): Promise<string> {
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const candidate = path.join(parent, attempt === 1 ? slug : `${slug}-${attempt}`);
    if (projectsDb.getProjectPath(candidate)) continue;
    const validation = await validate(candidate);
    if (!validation.valid) {
      throw new AppError('Invalid project path', { code: 'INVALID_PROJECT_PATH', statusCode: 400, details: validation.error });
    }
    try {
      await fsp.mkdir(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new AppError('No free directory name for the copy.', { code: 'NO_FREE_NAME', statusCode: 409 });
}

async function removeTarget(target: string): Promise<void> {
  try {
    if (isolatedAreaOf(target)) await isolatedFs.removeTree(target);
    else await fsp.rm(target, { recursive: true, force: true }); // unlinks symlinks, never follows them
  } catch (error) {
    console.warn(`[Projects] could not remove the partial copy ${target}: ${(error as Error).message}`);
  }
}

export async function startCopy(projectId: string, rawInput: CopyInput, deps: CopyDependencies = {}): Promise<{ jobId: string }> {
  const row = requireSource(projectId);
  const input = normalizeInput(rawInput);
  const sourcePath = row.project_path;
  const sourceIsolated = isolatedAreaOf(sourcePath) !== null;

  if (input.isolated) {
    const config = isolationConfig();
    if (!config.available) throw new AppError(config.reason ?? 'Isolation is not set up on this instance.', { code: 'ISOLATION_UNAVAILABLE', statusCode: 409 });
    const status = await daemonClient.status();
    if (!status.running) throw new AppError(`${SANDBOX_DOWN_TEXT} (${status.reason ?? 'daemon unreachable'}). The copy was not started.`, { code: 'SANDBOX_UNAVAILABLE', statusCode: 409 });
  }

  const servers = await userScopeMcpServers(sourcePath, deps);
  const carried: McpServers = {};
  for (const name of input.carryMcp) {
    if (!Object.prototype.hasOwnProperty.call(servers, name)) {
      throw new AppError(`MCP server "${name}" is not configured for the source project.`, { code: 'UNKNOWN_MCP_SERVER', statusCode: 400 });
    }
    carried[name] = servers[name];
  }

  assertSourceHoldsNoIsolationArea(sourcePath, sourceIsolated);
  // A plain copy of an isolated project (un-isolating it) goes to the workspaces root, not next to the source.
  const parent = input.isolated
    ? isolationConfig().isolatedRoot
    : sourceIsolated
      ? (deps.workspacesRoot ?? WORKSPACES_ROOT)
      : path.dirname(sourcePath);
  const target = await reserveTarget(parent, slugifyProjectName(input.name), input.isolated ? isolatedTargetCheck(parent) : (deps.validatePath ?? validateWorkspacePath));

  const jobId = randomUUID();
  const job: Job = {
    view: { jobId, copiedBytes: 0, totalBytes: null, done: false, warnings: [] },
    cancelled: false,
    finished: Promise.resolve(),
  };
  jobs.set(jobId, job);
  job.finished = runCopy(job, { sourcePath, target, input, carried, deps }).finally(() => {
    job.view.done = true;
    const timer = setTimeout(() => jobs.delete(jobId), JOB_KEEP_MS);
    timer.unref?.();
  });
  return { jobId };
}

// ---------------------------------------------------------------------------------------------------------------
// The copy itself

type RunContext = {
  sourcePath: string;
  target: string;
  input: CopyInput;
  carried: McpServers;
  deps: CopyDependencies;
};

const isInside = (child: string, root: string) => child === root || child.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

async function runCopy(job: Job, context: RunContext): Promise<void> {
  const { sourcePath, target, input, carried, deps } = context;
  const reader = readerFor(sourcePath);
  const cancelled = () => job.cancelled;
  const exclude = new Set(input.excludeSecretFiles);
  let projectId: string | null = null;
  try {
    // Pass 1: the size, so the progress has a total.
    let total = 0;
    await walk(reader, {
      async dir(rel) {
        return !exclude.has(rel);
      },
      async file(rel, entry) {
        if (!exclude.has(rel)) total += entry.size;
      },
    }, cancelled);
    job.view.totalBytes = total;

    const roots = [sourcePath];
    try {
      roots.push(await fsp.realpath(sourcePath));
    } catch {
      // The source is gone; the walk below fails with a proper error.
    }

    // Pass 2: the copy.
    await walk(reader, {
      async dir(rel) {
        if (exclude.has(rel)) return false;
        await fsp.mkdir(path.join(target, rel));
        return true;
      },
      async file(rel, entry) {
        if (exclude.has(rel)) return;
        await reader.copyFile(rel, path.join(target, rel), entry.mode || 0o644, (bytes) => {
          job.view.copiedBytes += bytes;
        });
        await deps.afterEntry?.(rel);
      },
      async symlink(rel) {
        if (exclude.has(rel)) return;
        let linkText: string;
        try {
          linkText = await reader.readlink(rel);
        } catch (error) {
          job.view.warnings.push(`Skipped the symbolic link ${rel}: ${(error as Error).message}`);
          return;
        }
        const link = path.join(sourcePath, rel);
        const resolved = path.resolve(path.dirname(link), linkText);
        const base = roots.find((root) => isInside(resolved, root));
        if (!base) {
          job.view.warnings.push(`Skipped the symbolic link ${rel}: it points outside the project.`);
          return;
        }
        const baseLink = isInside(link, base) ? link : path.join(base, rel);
        await fsp.symlink(path.relative(path.dirname(baseLink), resolved) || '.', path.join(target, rel));
      },
      async other(rel) {
        job.view.warnings.push(`Skipped ${rel}: not a regular file, directory or symbolic link.`);
      },
    }, cancelled);

    if (Object.keys(carried).length > 0 && input.isolated) await carryMcpIntoProject(target, carried);

    const created = registerCopy(target, input.name);
    projectId = created.projectId;

    if (input.isolated) {
      const { warnings } = await isolationService.provision(created.projectId);
      job.view.warnings.push(...warnings);
    } else if (Object.keys(carried).length > 0) {
      await carryMcpIntoClaudeJson(target, carried, deps);
    }
    job.view.project = created;
  } catch (error) {
    job.view.error = error instanceof Error && error.message ? error.message : 'Copy failed.';
    job.view.project = undefined;
    if (projectId) {
      try {
        const wasIsolated = isolationDb.getById(projectId) !== null;
        if (wasIsolated) {
          const home = isolationDb.getById(projectId)!.homeDir;
          if (home && isolatedAreaOf(home)) await isolatedFs.removeTree(home).catch(() => undefined);
        }
        projectsDb.deleteProjectById(projectId);
        if (wasIsolated) await isolationService.forget(projectId);
      } catch (cleanupError) {
        console.warn(`[Projects] could not drop the registration of the failed copy: ${(cleanupError as Error).message}`);
      }
    }
    await removeTarget(target);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Registration

function registerCopy(target: string, name: string): CopiedProject {
  const result = projectsDb.createProjectPath(target, name);
  const row: ProjectRepositoryRow | null = result.outcome === 'active_conflict' ? null : result.project;
  if (!row) throw new AppError('Project path already exists and is active', { code: 'PROJECT_ALREADY_EXISTS', statusCode: 409 });
  projectsDb.updateCustomProjectNameById(row.project_id, name);
  return {
    projectId: row.project_id,
    path: row.project_path,
    fullPath: row.project_path,
    displayName: name,
    customName: name,
    isArchived: false,
    isStarred: Boolean(row.isStarred),
    sessions: [],
    sessionMeta: { hasMore: false, total: 0 },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// carryMcp

async function readJsonFile(file: string): Promise<Record<string, any>> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, any>) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/** Isolated copy: servers go into the copy's own `.mcp.json` and are enabled in `.claude/settings.local.json`. */
async function carryMcpIntoProject(target: string, carried: McpServers): Promise<void> {
  const mcpFile = path.join(target, '.mcp.json');
  const mcp = await readJsonFile(mcpFile);
  mcp.mcpServers = { ...(mcp.mcpServers ?? {}), ...carried };
  await fsp.writeFile(mcpFile, `${JSON.stringify(mcp, null, 2)}\n`, { mode: 0o660 });

  const settingsDir = path.join(target, '.claude');
  await fsp.mkdir(settingsDir, { recursive: true });
  const settingsFile = path.join(settingsDir, 'settings.local.json');
  const settings = await readJsonFile(settingsFile);
  const enabled = Array.isArray(settings.enabledMcpjsonServers) ? (settings.enabledMcpjsonServers as unknown[]) : [];
  settings.enabledMcpjsonServers = [...new Set([...enabled, ...Object.keys(carried)])];
  await fsp.writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o660 });
}

/** Plain copy: servers go into the app's `~/.claude.json` under projects[<target>] (temp file + rename). */
async function carryMcpIntoClaudeJson(target: string, carried: McpServers, deps: CopyDependencies): Promise<void> {
  const file = defaultClaudeJson(deps);
  const config = await readClaudeJson(file);
  const projects = (config.projects && typeof config.projects === 'object' ? config.projects : {}) as Record<string, Record<string, any>>;
  const entry = projects[target] ?? {};
  entry.mcpServers = { ...(entry.mcpServers ?? {}), ...carried };
  projects[target] = entry;
  config.projects = projects;
  let mode = 0o600;
  try {
    mode = (await fsp.stat(file)).mode & 0o777;
  } catch {
    // New file.
  }
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode });
  await fsp.rename(temp, file);
}

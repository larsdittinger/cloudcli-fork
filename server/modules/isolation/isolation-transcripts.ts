// Claude transcripts of isolated projects live in their homes (<isolatedHomes>/<projectId>/.claude/projects), which
// the app reads but the agent writes. Indexing them must not let an agent plant sessions in other projects,
// take over existing sessions, or point the app at files outside its home.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { isolationConfig } from '@/modules/isolation/isolation.config.js';
import { isolationDb } from '@/modules/isolation/isolation.db.js';

const isRealDir = (p: string) => {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isInside = (child: string, parent: string) =>
  Boolean(parent) && (child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`));

/** Every directory Claude transcripts live in: the app's own, then each isolated home's (real directories only). */
export function claudeTranscriptRoots(): string[] {
  const roots = [path.join(os.homedir(), '.claude', 'projects')];
  const homes = isolationConfig().isolatedHomes;
  if (!homes) return roots;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(homes, { withFileTypes: true });
  } catch {
    return roots;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue; // a symlinked home is never followed
    const claudeDir = path.join(homes, entry.name, '.claude');
    const projects = path.join(claudeDir, 'projects');
    if (isRealDir(claudeDir) && isRealDir(projects)) roots.push(projects);
  }
  return roots;
}

/** The parent of all isolated homes, watched as one more transcript root (new homes appear at runtime). */
export function isolatedHomesRoot(): string | null {
  return isolationConfig().isolatedHomes || null;
}

/**
 * chokidar filter for the homes root: descend only along <home>/.claude/projects, never into subagent
 * transcripts or tool results (like the main watcher), never anywhere else in a home (caches, node_modules).
 */
export function isIsolatedHomeWatchPath(filePath: string): boolean {
  const homes = isolatedHomesRoot();
  if (!homes) return false;
  const relative = path.relative(homes, filePath);
  if (relative === '') return true;
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);
  if (parts.length >= 2 && parts[1] !== '.claude') return false;
  if (parts.length >= 3 && parts[2] !== 'projects') return false;
  return !parts.includes('subagents') && !parts.includes('tool-results');
}

/** The isolated project whose home holds `filePath`, by location; null when the file is not in an isolated home. */
function homeProjectId(filePath: string): string | null {
  const homes = isolatedHomesRoot();
  if (!homes) return null;
  const relative = path.relative(path.resolve(homes), path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep)[0] || null;
}

/** Before a transcript is read: in an isolated home only a regular file (no symlink, FIFO…) inside that home. */
export function isReadableTranscript(filePath: string): boolean {
  const projectId = homeProjectId(filePath);
  if (projectId === null) return true;
  const homes = isolatedHomesRoot()!;
  try {
    if (!fs.lstatSync(filePath).isFile()) return false;
    return isInside(fs.realpathSync(filePath), path.join(fs.realpathSync(homes), projectId));
  } catch {
    return false;
  }
}

/**
 * Whether a provider session id may become (or stay) a session of the isolated project `projectId`: it must not
 * name a session of any other project. `appSessionId` is the session the run belongs to (its own row is fine).
 */
export function isProviderSessionIdFree(projectId: string, providerSessionId: string, appSessionId?: string | null): boolean {
  const existing = sessionsDb.getSessionByProviderSessionId(providerSessionId) ?? sessionsDb.getSessionById(providerSessionId);
  if (!existing || (appSessionId && existing.session_id === appSessionId)) return true;
  return isolationDb.getByPath(existing.project_path ?? '')?.projectId === projectId;
}

/**
 * After a transcript was parsed: one from an isolated home counts only for a session of that same isolated
 * project — its cwd inside the project, and its session id not one of a session elsewhere.
 */
export function acceptTranscript(filePath: string, parsed: { sessionId: string; projectPath: string }): boolean {
  const projectId = homeProjectId(filePath);
  if (projectId === null) return true;
  if (!isReadableTranscript(filePath)) return false;
  const project = isolationDb.getById(projectId);
  if (!project) return false;
  const owner = isolationDb.getByPath(parsed.projectPath);
  if (owner?.projectId !== project.projectId) return false;
  return isProviderSessionIdFree(project.projectId, parsed.sessionId);
}

export class TranscriptRefusedError extends Error {}

const hasProcFd = fs.existsSync('/proc/self/fd');
const DIR_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
// O_NONBLOCK: opening a FIFO for reading would otherwise wait for a writer (and pin a threadpool worker).
const FILE_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

/** Whether `filePath` lies in an isolated home, i.e. in a tree the agent writes. */
export function isIsolatedTranscriptPath(filePath: string): boolean {
  return homeProjectId(filePath) !== null;
}

/**
 * Opens a file or directory in an isolated home without following a symlink anywhere below the homes root: every
 * directory is opened with O_NOFOLLOW relative to the previous one (through /proc/self/fd where it exists, i.e.
 * Linux), and a file must be a regular file. Returns the fd; throws TranscriptRefusedError otherwise.
 */
function openUnderHomes(target: string, kind: 'file' | 'dir'): number {
  const homes = path.resolve(isolatedHomesRoot()!);
  const parts = path.relative(homes, path.resolve(target)).split(path.sep);
  if (parts.length < (kind === 'file' ? 2 : 1) || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new TranscriptRefusedError(`Not inside an isolated home: ${target}`);
  }
  // The homes root itself belongs to the deployment, not to an agent.
  let dirFd = fs.openSync(homes, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  let dirPath = homes;
  const at = (name: string) => (hasProcFd ? `/proc/self/fd/${dirFd}/${name}` : path.join(dirPath, name));
  const dirs = kind === 'dir' ? parts : parts.slice(0, -1);
  try {
    for (const part of dirs) {
      let next: number;
      try {
        next = fs.openSync(at(part), DIR_FLAGS);
      } catch (error) {
        throw new TranscriptRefusedError(`${path.join(dirPath, part)}: not a plain directory (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
      }
      fs.closeSync(dirFd);
      dirFd = next;
      dirPath = path.join(dirPath, part);
    }
    if (kind === 'dir') {
      const fd = dirFd;
      dirFd = -1; // handed to the caller
      return fd;
    }
    let fd: number;
    try {
      fd = fs.openSync(at(parts[parts.length - 1]), FILE_FLAGS);
    } catch (error) {
      throw new TranscriptRefusedError(`${target}: not a plain file (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    }
    if (!fs.fstatSync(fd).isFile()) {
      fs.closeSync(fd);
      throw new TranscriptRefusedError(`${target}: not a regular file`);
    }
    return fd;
  } finally {
    if (dirFd >= 0) fs.closeSync(dirFd);
  }
}

const openIsolatedFd = (filePath: string) => openUnderHomes(filePath, 'file');

const warned = new Set<string>();

/** One log line per cap and place for the life of the process. */
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[Isolation] ${message}`);
}

/**
 * A read stream over a Claude transcript. In an isolated home the file is opened safely (see openIsolatedFd);
 * anywhere else exactly as before. `maxBytes` stops the stream after that many bytes.
 */
export async function openTranscriptStream(filePath: string, options: { maxBytes?: number } = {}): Promise<fs.ReadStream> {
  const end = options.maxBytes && options.maxBytes > 0 ? { end: options.maxBytes - 1 } : {};
  if (!isIsolatedTranscriptPath(filePath)) return fs.createReadStream(filePath, end);
  const fd = openIsolatedFd(filePath);
  if (options.maxBytes && fs.fstatSync(fd).size > options.maxBytes) {
    warnOnce(`max-bytes:${homeProjectId(filePath)}`, `${filePath} is larger than ${options.maxBytes} bytes; only its start is read.`);
  }
  return fs.createReadStream(filePath, { fd, autoClose: true, ...end });
}

/** The whole text of a Claude transcript, read like openTranscriptStream. */
export async function readTranscriptText(filePath: string): Promise<string> {
  if (!isIsolatedTranscriptPath(filePath)) return fsp.readFile(filePath, 'utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of await openTranscriptStream(filePath)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Caps of the walk over one isolated home's transcripts (the agent decides how many entries and how deep). */
export const ISOLATED_TRANSCRIPT_LIMITS = { maxDepth: 6, maxEntries: 5000, maxFirstLineBytes: 1024 * 1024 };

/**
 * The .jsonl files under one isolated home's `.claude/projects`, created after `since`, without subagent
 * transcripts and tool results. The tree is the agent's, so the walk
 * - never follows a symlink: each directory is opened with O_DIRECTORY | O_NOFOLLOW relative to its parent's fd
 *   and listed through that fd (streaming, so a huge directory is never loaded at once);
 * - goes at most `maxDepth` levels deep;
 * - spends one unit of a per-home budget on every entry it looks at (directories, skipped and non-matching files
 *   too) and stops when `maxEntries` is spent — also on syncs where `since` skips everything.
 */
export async function findIsolatedTranscripts(
  root: string,
  since: Date | null,
  limits: { maxDepth?: number; maxEntries?: number; /** Tests: called for every entry visited. */ onEntry?: (entryPath: string) => void } = {},
): Promise<string[]> {
  const maxDepth = limits.maxDepth ?? ISOLATED_TRANSCRIPT_LIMITS.maxDepth;
  let budget = limits.maxEntries ?? ISOLATED_TRANSCRIPT_LIMITS.maxEntries;
  let exhausted = false;
  const files: string[] = [];

  let rootFd: number;
  try {
    rootFd = openUnderHomes(root, 'dir');
  } catch {
    return files;
  }

  const walk = async (dirFd: number, dirPath: string, depth: number): Promise<void> => {
    let listing: fs.Dir;
    try {
      listing = await fsp.opendir(hasProcFd ? `/proc/self/fd/${dirFd}` : dirPath);
    } catch {
      return; // unreadable: skipped, the rest of the home is still walked
    }
    for await (const entry of listing) {
      if (budget <= 0) {
        exhausted = true;
        break;
      }
      budget -= 1;
      const full = path.join(dirPath, entry.name);
      limits.onEntry?.(full);
      const at = hasProcFd ? `/proc/self/fd/${dirFd}/${entry.name}` : full;
      if (entry.isDirectory()) {
        if (entry.name === 'subagents' || entry.name === 'tool-results') continue;
        if (depth >= maxDepth) {
          warnOnce(`max-depth:${root}`, `${root} nests deeper than ${maxDepth} levels; deeper transcripts are not indexed.`);
          continue;
        }
        let childFd: number;
        try {
          childFd = fs.openSync(at, DIR_FLAGS); // swapped for a symlink since the listing: ELOOP, skipped
        } catch {
          continue;
        }
        try {
          await walk(childFd, full, depth + 1);
        } finally {
          fs.closeSync(childFd);
        }
        if (exhausted) break;
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        if (since) {
          try {
            if ((await fsp.lstat(at)).birthtime <= since) continue;
          } catch {
            continue;
          }
        }
        files.push(full);
      }
    }
  };

  try {
    await walk(rootFd, path.resolve(root), 0);
  } catch {
    // An unreadable directory ends the walk of this home; what was found stays.
  } finally {
    fs.closeSync(rootFd);
  }
  if (exhausted) {
    warnOnce(`max-entries:${root}`, `${root} holds more than ${limits.maxEntries ?? ISOLATED_TRANSCRIPT_LIMITS.maxEntries} entries; the walk stopped there.`);
  }
  return files;
}

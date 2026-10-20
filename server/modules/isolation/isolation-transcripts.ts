// Claude transcripts of isolated projects live in their homes (<isolatedHomes>/<projectId>/.claude/projects), which
// the app reads but the agent writes. Indexing them must not let an agent plant sessions in other projects,
// take over existing sessions, or point the app at files outside its home.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { openIsolatedPath } from '@/modules/isolation/isolated-fs.js';
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

/** Whether `filePath` lies in an isolated home, i.e. in a tree the agent writes. */
export function isIsolatedTranscriptPath(filePath: string): boolean {
  return homeProjectId(filePath) !== null;
}

/**
 * Opens a file or directory in an isolated home without following a symlink anywhere below the homes root (see
 * openIsolatedPath); a file must be a regular file. Returns the fd; throws TranscriptRefusedError otherwise.
 */
function openUnderHomes(target: string, kind: 'file' | 'dir'): number {
  const homes = path.resolve(isolatedHomesRoot()!);
  const rel = path.relative(homes, path.resolve(target));
  const parts = rel.split(path.sep);
  if (parts.length < (kind === 'file' ? 2 : 1) || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new TranscriptRefusedError(`Not inside an isolated home: ${target}`);
  }
  try {
    return openIsolatedPath(homes, rel, kind === 'file' ? 'read' : 'dir');
  } catch (error) {
    throw new TranscriptRefusedError(`${target}: ${(error as Error).message}`);
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

/**
 * The whole text of a Claude transcript, read like openTranscriptStream. In an isolated home at most
 * ISOLATED_TRANSCRIPT_LIMITS.maxTextBytes: a bigger file counts as unreadable (TranscriptRefusedError, logged once).
 */
export async function readTranscriptText(filePath: string): Promise<string> {
  if (!isIsolatedTranscriptPath(filePath)) return fsp.readFile(filePath, 'utf8');
  const maxBytes = ISOLATED_TRANSCRIPT_LIMITS.maxTextBytes;
  const fd = openIsolatedFd(filePath);
  const tooBig = () => {
    warnOnce(`max-text:${homeProjectId(filePath)}`, `${filePath} is larger than ${maxBytes} bytes; it is not read as a whole.`);
    return new TranscriptRefusedError(`${filePath} is larger than ${maxBytes} bytes`);
  };
  if (fs.fstatSync(fd).size > maxBytes) {
    fs.closeSync(fd);
    throw tooBig();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  // One byte past the cap tells a file that grew while it was read.
  for await (const chunk of fs.createReadStream(filePath, { fd, autoClose: true, end: maxBytes })) {
    chunks.push(chunk as Buffer);
    total += (chunk as Buffer).length;
  }
  if (total > maxBytes) throw tooBig();
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The last `maxBytes` of a transcript in an isolated home, opened safely, starting at a row boundary
 * (`isComplete` when the whole file fit). For the token usage lookup.
 */
export async function readTranscriptTail(filePath: string, maxBytes: number): Promise<{ content: string; isComplete: boolean }> {
  const fd = openIsolatedFd(filePath);
  try {
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = await new Promise<number>((resolve, reject) => {
        fs.read(fd, buffer, read, length - read, size - length + read, (error, bytes) => (error ? reject(error) : resolve(bytes)));
      });
      if (count === 0) break;
      read += count;
    }
    const content = buffer.subarray(0, read).toString('utf8');
    if (size <= maxBytes) return { content, isComplete: true };
    const firstNewline = content.indexOf('\n');
    return { content: firstNewline === -1 ? '' : content.slice(firstNewline + 1), isComplete: false };
  } finally {
    fs.closeSync(fd);
  }
}

/** Caps of the walk over one isolated home's transcripts (the agent decides how many entries and how deep). */
export const ISOLATED_TRANSCRIPT_LIMITS = {
  maxDepth: 6,
  maxEntries: 5000,
  maxFirstLineBytes: 1024 * 1024,
  /** Whole-file reads (titles, the current model); history is streamed instead. */
  maxTextBytes: 8 * 1024 * 1024,
};

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

/** How often the isolated homes are walked for new or changed transcripts (the main watcher polls as often). */
export const ISOLATED_TRANSCRIPT_POLL_MS = 6_000;

/**
 * Watches every isolated home's transcripts by walking it with findIsolatedTranscripts every `intervalMs` (bounded
 * in depth and entries per home) instead of a file watcher: an agent decides how many files and directories its
 * home holds, and a watcher would spend inotify watches or a stat timer on each. The first walk only records what
 * is there; later walks report files that appeared ('add') or whose size or mtime changed ('change').
 */
export function startIsolatedTranscriptPoller(
  onChange: (event: 'add' | 'change', filePath: string) => void,
  options: { intervalMs?: number; limits?: { maxDepth?: number; maxEntries?: number } } = {},
): { tick(): Promise<void>; stop(): Promise<void> } {
  let known: Map<string, string> | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  const walk = async () => {
    const seen = new Map<string, string>();
    for (const root of claudeTranscriptRoots().slice(1)) {
      for (const file of await findIsolatedTranscripts(root, null, options.limits)) {
        let stamp: string;
        try {
          const stats = await fsp.lstat(file);
          if (!stats.isFile()) continue;
          stamp = `${stats.size}:${stats.mtimeMs}`;
        } catch {
          continue;
        }
        seen.set(file, stamp);
        if (!known || stopped) continue;
        const previous = known.get(file);
        if (previous === undefined) onChange('add', file);
        else if (previous !== stamp) onChange('change', file);
      }
    }
    known = seen;
  };

  const tick = () => {
    running ??= walk()
      .catch((error) => console.error('[Isolation] Walking the isolated homes failed', error))
      .finally(() => {
        running = null;
      });
    return running;
  };

  const timer = setInterval(() => void tick(), options.intervalMs ?? ISOLATED_TRANSCRIPT_POLL_MS);
  timer.unref();
  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}

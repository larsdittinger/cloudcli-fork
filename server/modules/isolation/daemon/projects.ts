// Spawn validation and project preparation (ownership, modes, home with .claude.json). Node builtins only.
import fs from 'node:fs';
import path from 'node:path';

import { MIN_ISOLATED_UID } from './firewall.js';
import type { ProjectStore } from './project-store.js';
import type { SpawnRequest } from './process-host.js';

export class RejectedError extends Error {}

export type PathConfig = {
  isolatedRoot: string;
  isolatedHomes: string;
  /** Owner uid of a path. Production: real stat. Tests simulate a foreign owner. */
  statOwner: (p: string) => number;
};

export const defaultStatOwner = (p: string): number => fs.statSync(p).uid;

const isInside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** projectDir must be a direct child of the (real) isolated root and not reachable through a symlink. Returns its real path. */
export function resolveProjectDir(projectDir: string, config: PathConfig): string {
  let rootReal: string;
  let real: string;
  try {
    rootReal = fs.realpathSync(config.isolatedRoot);
    real = fs.realpathSync(projectDir);
  } catch {
    throw new RejectedError('projectDir does not exist');
  }
  const base = path.basename(real);
  if (path.dirname(real) !== rootReal || !base) throw new RejectedError('projectDir is not a direct child of the isolated root');
  // The given path must name that directory itself, not a symlink to it (or through one).
  const given = path.resolve(projectDir);
  if (given !== real && given !== path.join(path.resolve(config.isolatedRoot), base)) {
    throw new RejectedError('projectDir is not a direct child of the isolated root');
  }
  if (fs.lstatSync(given).isSymbolicLink()) throw new RejectedError('projectDir must not be a symlink');
  return real;
}

export function expectedHome(projectId: string, config: PathConfig): string {
  return path.join(path.resolve(config.isolatedHomes), projectId);
}

/** Checked for every spawn kind before anything runs. Throws RejectedError. */
/** Returns the real projectDir the process must be created in. */
export function validateSpawn(req: SpawnRequest, store: ProjectStore, config: PathConfig): string {
  const project = store.get(req.projectId);
  if (!project) throw new RejectedError(`unknown project ${req.projectId}`);
  if (!Number.isInteger(req.uid) || req.uid < MIN_ISOLATED_UID) throw new RejectedError(`uid below ${MIN_ISOLATED_UID}`);
  if (req.uid !== project.uid) throw new RejectedError('uid does not match the project');
  const real = resolveProjectDir(req.projectDir, config);
  if (path.resolve(req.homeDir) !== expectedHome(req.projectId, config)) throw new RejectedError('homeDir is not the project home');
  let owner: number;
  try {
    owner = config.statOwner(real);
  } catch {
    throw new RejectedError('projectDir owner unknown');
  }
  if (owner !== req.uid) throw new RejectedError('projectDir is not owned by the project uid');
  let cwdReal: string;
  try {
    cwdReal = fs.realpathSync(req.cwd);
  } catch {
    throw new RejectedError('cwd does not exist');
  }
  if (!isInside(cwdReal, real)) throw new RejectedError('cwd is outside the project');
  return real;
}

type TreeOptions = { uid: number; gid: number; chown: boolean; warnings: string[]; procFd: boolean };

const MAX_CLAUDE_JSON_BYTES = 16 * 1024 * 1024;

const NOFOLLOW = fs.constants.O_NOFOLLOW;
const hasProcFd = fs.existsSync('/proc/self/fd');

/**
 * Owner + modes for a tree without ever following symlinks. The daemon is root and the tree is writable by the
 * agent, so every step works on an fd opened with O_NOFOLLOW, and children are reached through /proc/self/fd/<dirfd>
 * (an openat equivalent) so a directory swapped for a symlink mid-walk cannot redirect chown/chmod.
 */
function applyTree(dirPath: string, opts: TreeOptions): void {
  const dirFd = fs.openSync(dirPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | NOFOLLOW);
  try {
    if (opts.chown) fs.fchownSync(dirFd, opts.uid, opts.gid);
    fs.fchmodSync(dirFd, 0o2770);
    const base = opts.procFd ? `/proc/self/fd/${dirFd}` : dirPath;
    for (const name of fs.readdirSync(base)) {
      const child = `${base}/${name}`;
      const display = path.join(dirPath, name);
      try {
        const st = fs.lstatSync(child);
        if (st.isSymbolicLink()) {
          if (opts.chown) fs.lchownSync(child, opts.uid, opts.gid);
        } else if (st.isDirectory()) {
          applyTree(opts.procFd ? child : display, opts);
        } else if (st.isFile()) {
          const fd = fs.openSync(child, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | NOFOLLOW);
          try {
            const real = fs.fstatSync(fd);
            if (!real.isFile()) continue;
            if (opts.chown) fs.fchownSync(fd, opts.uid, opts.gid);
            fs.fchmodSync(fd, (real.mode & 0o777) | 0o060); // g+rw, setuid/setgid dropped
          } finally {
            fs.closeSync(fd);
          }
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        if (code === 'ELOOP' && opts.chown) {
          try {
            fs.lchownSync(child, opts.uid, opts.gid);
            continue;
          } catch {
            // fall through to the warning
          }
        }
        opts.warnings.push(`${display}: ${(error as Error).message}`);
      }
    }
  } finally {
    fs.closeSync(dirFd);
  }
}

export type PrepareInput = { projectId: string; uid: number; projectDir: string; homeDir: string };

export function prepareProject(
  input: PrepareInput,
  config: PathConfig & { dev: boolean; mainGid?: number; /** Tests: pretend /proc/self/fd is (not) there. */ procFd?: boolean },
): { warnings: string[] } {
  if (!Number.isInteger(input.uid) || input.uid < MIN_ISOLATED_UID) throw new RejectedError(`uid below ${MIN_ISOLATED_UID}`);
  const real = resolveProjectDir(input.projectDir, config);
  const home = expectedHome(input.projectId, config);
  if (path.resolve(input.homeDir) !== home) throw new RejectedError('homeDir is not the project home');
  const chown = !config.dev;
  const procFd = config.procFd ?? hasProcFd;
  // Without /proc/self/fd the walk would be path based, i.e. open to symlink swaps by the agent while we run as root.
  if (chown && !procFd) throw new RejectedError('/proc/self/fd is unavailable: refusing to chown an agent-writable tree');
  const opts: TreeOptions = { uid: input.uid, gid: config.mainGid ?? 0, chown, warnings: [], procFd };

  fs.mkdirSync(home, { recursive: true });
  if (!fs.lstatSync(home).isDirectory()) throw new RejectedError('homeDir is not a directory');

  // The home is agent-writable: never read or write .claude.json through a planted symlink.
  const file = path.join(home, '.claude.json');
  let current: Record<string, unknown> = {};
  try {
    // O_NONBLOCK: a FIFO planted by the agent must not hang the daemon on open/read.
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > MAX_CLAUDE_JSON_BYTES) {
        opts.warnings.push(`${file}: not a regular file or larger than 16 MB, replaced`);
      } else {
        const parsed = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    current = {};
  }
  const projects = current.projects && typeof current.projects === 'object' ? (current.projects as Record<string, Record<string, unknown>>) : {};
  const trusted = { ...projects };
  for (const key of new Set([real, path.resolve(input.projectDir)])) {
    trusted[key] = { ...(trusted[key] ?? {}), hasTrustDialogAccepted: true };
  }
  const merged = { ...current, hasCompletedOnboarding: true, projects: trusted };
  const tmp = path.join(home, `.claude.json.tmp-${process.pid}`);
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { flag: 'wx', mode: 0o660 });
  fs.renameSync(tmp, file);

  applyTree(home, opts);
  applyTree(real, opts);
  ensurePrivateTmp(home, opts);
  return { warnings: opts.warnings };
}

/** Name of the project's own temp dir in its home (TMPDIR / CLAUDE_CODE_TMPDIR of every process of the project). */
export const HOME_TMP_DIR = '.tmp';

/**
 * <home>/.tmp as a real directory, mode 0700, owned by the project uid. The home is agent-writable: a symlink or
 * any other non-directory found there is removed (never followed) and the directory created in its place.
 */
function ensurePrivateTmp(home: string, opts: TreeOptions): void {
  const homeFd = fs.openSync(home, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | NOFOLLOW);
  try {
    const at = `${opts.procFd ? `/proc/self/fd/${homeFd}` : home}/${HOME_TMP_DIR}`;
    const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NONBLOCK | NOFOLLOW;
    let fd: number;
    try {
      fd = fs.openSync(at, flags);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fs.unlinkSync(at); // symlink, file, FIFO: the entry itself goes
      fs.mkdirSync(at, { mode: 0o700 });
      fd = fs.openSync(at, flags);
    }
    try {
      if (opts.chown) fs.fchownSync(fd, opts.uid, opts.gid);
      fs.fchmodSync(fd, 0o700);
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    fs.closeSync(homeFd);
  }
}

export type AdoptInput = { projectId: string; uid: number; projectDir: string; paths: string[] };

const MAX_ADOPT_PATHS = 256;

/** A path relative to the project: plain components only, no `..`, `.`, empty parts or NUL. */
function adoptPathParts(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw || raw.length > 4096 || raw.includes('\0') || raw.startsWith('/')) {
    throw new RejectedError('paths must be non-empty paths relative to the project');
  }
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new RejectedError(`invalid path ${JSON.stringify(raw)}`);
  }
  return parts;
}

/**
 * Hands files the app wrote into the project (attachments) over to the project uid: owner + modes of every
 * component of each path — the directories on the way non-recursively, the final entry recursively when it is a
 * directory. The walk never follows a symlink (same fd technique as applyTree); one on the way is a rejection.
 */
export function adoptPaths(
  input: AdoptInput,
  config: PathConfig & { dev: boolean; mainGid?: number; /** Tests: pretend /proc/self/fd is (not) there. */ procFd?: boolean },
): { warnings: string[] } {
  if (!Number.isInteger(input.uid) || input.uid < MIN_ISOLATED_UID) throw new RejectedError(`uid below ${MIN_ISOLATED_UID}`);
  if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > MAX_ADOPT_PATHS) {
    throw new RejectedError(`paths must list 1 to ${MAX_ADOPT_PATHS} entries`);
  }
  const parsed = input.paths.map(adoptPathParts);
  const real = resolveProjectDir(input.projectDir, config);
  const chown = !config.dev;
  const procFd = config.procFd ?? hasProcFd;
  if (chown && !procFd) throw new RejectedError('/proc/self/fd is unavailable: refusing to chown an agent-writable tree');
  const opts: TreeOptions = { uid: input.uid, gid: config.mainGid ?? 0, chown, warnings: [], procFd };
  for (const parts of parsed) adoptOne(real, parts, opts);
  return { warnings: opts.warnings };
}

function adoptOne(projectReal: string, parts: string[], opts: TreeOptions): void {
  const rel = parts.join('/');
  let dirFd = fs.openSync(projectReal, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | NOFOLLOW);
  let dirPath = projectReal;
  try {
    for (let index = 0; index < parts.length; index += 1) {
      const last = index === parts.length - 1;
      const child = `${opts.procFd ? `/proc/self/fd/${dirFd}` : dirPath}/${parts[index]}`;
      const display = path.join(dirPath, parts[index]);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(child);
      } catch {
        throw new RejectedError(`${rel}: does not exist`);
      }
      if (st.isSymbolicLink()) throw new RejectedError(`${rel}: ${display} is a symlink`);
      if (st.isDirectory()) {
        if (last) {
          applyTree(opts.procFd ? child : display, opts); // opens with O_NOFOLLOW itself
          return;
        }
        const next = fs.openSync(child, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | NOFOLLOW);
        try {
          if (opts.chown) fs.fchownSync(next, opts.uid, opts.gid);
          fs.fchmodSync(next, 0o2770);
        } catch (error) {
          fs.closeSync(next);
          throw error;
        }
        fs.closeSync(dirFd);
        dirFd = next;
        dirPath = display;
        continue;
      }
      if (!last || !st.isFile()) throw new RejectedError(`${rel}: ${display} is not a regular file or directory`);
      const fd = fs.openSync(child, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | NOFOLLOW);
      try {
        const real = fs.fstatSync(fd);
        if (!real.isFile()) throw new RejectedError(`${rel}: not a regular file`);
        if (opts.chown) fs.fchownSync(fd, opts.uid, opts.gid);
        fs.fchmodSync(fd, (real.mode & 0o777) | 0o060);
      } finally {
        fs.closeSync(fd);
      }
    }
  } finally {
    fs.closeSync(dirFd);
  }
}

export type ShareInput = { projectId: string; uid: number };
export type ShareResult = { changed: number; visited: number; truncated: boolean; warnings: string[] };

/** Same bounds as the app's own walk over a home's transcripts (isolation-transcripts.ts). */
export const SHARE_LIMITS = { maxDepth: 6, maxEntries: 5000 };
const MAX_SHARE_WARNINGS = 20;

/**
 * Makes the Claude transcripts in a project's home readable for the app. The CLI writes them 0600 in directories it
 * creates 0700, so the setgid group (the app's gid) alone gives the app nothing. Only `<home>/.claude` and
 * `<home>/.claude/projects/**` are touched: files get g+r, directories g+rx and setgid; owner and owner bits stay.
 * The tree is the agent's, so the walk works like applyTree — every step on an fd opened with O_NOFOLLOW, children
 * through /proc/self/fd/<dirfd> — and is bounded (depth, entries per call). Symlinks, FIFOs and anything else that
 * is not a regular file or directory are skipped; in production also entries not owned by the project uid and files
 * with more than one link.
 */
export function shareTranscripts(
  input: ShareInput,
  config: PathConfig & {
    dev: boolean;
    mainGid?: number;
    /** Tests: pretend /proc/self/fd is (not) there. */
    procFd?: boolean;
    limits?: { maxDepth?: number; maxEntries?: number };
  },
): ShareResult {
  if (!Number.isInteger(input.uid) || input.uid < MIN_ISOLATED_UID) throw new RejectedError(`uid below ${MIN_ISOLATED_UID}`);
  const prod = !config.dev;
  const procFd = config.procFd ?? hasProcFd;
  if (prod && !procFd) throw new RejectedError('/proc/self/fd is unavailable: refusing to walk an agent-writable tree');
  const maxDepth = config.limits?.maxDepth ?? SHARE_LIMITS.maxDepth;
  const maxEntries = config.limits?.maxEntries ?? SHARE_LIMITS.maxEntries;
  const result: ShareResult = { changed: 0, visited: 0, truncated: false, warnings: [] };
  const warn = (message: string) => {
    if (result.warnings.length < MAX_SHARE_WARNINGS) result.warnings.push(message);
  };
  const mainGid = prod ? config.mainGid : undefined;
  const DIR_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NONBLOCK | NOFOLLOW;
  const at = (dirFd: number, dirPath: string, name: string) => (procFd ? `/proc/self/fd/${dirFd}/${name}` : path.join(dirPath, name));

  /** g+rx and setgid on an opened directory (and the app's group). False when it is not the project's. */
  const shareDir = (fd: number, display: string): boolean => {
    const st = fs.fstatSync(fd);
    if (prod && st.uid !== input.uid) {
      warn(`${display}: not owned by the project uid, skipped`);
      return false;
    }
    if (mainGid !== undefined && st.gid !== mainGid) {
      fs.fchownSync(fd, st.uid, mainGid);
      result.changed += 1;
    }
    const want = (st.mode & 0o777) | 0o2050;
    if ((st.mode & 0o7777) !== want) {
      fs.fchmodSync(fd, want);
      result.changed += 1;
    }
    return true;
  };

  /** A directory below `parentFd`, never through a symlink; null when it is missing or not a real directory. */
  const openDir = (parentFd: number, parentPath: string, name: string): number | null => {
    try {
      return fs.openSync(at(parentFd, parentPath, name), DIR_FLAGS);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') warn(`${path.join(parentPath, name)}: ${code === 'ELOOP' || code === 'ENOTDIR' ? 'not a directory, skipped' : (error as Error).message}`);
      return null;
    }
  };

  const shareFile = (child: string, display: string): void => {
    const fd = fs.openSync(child, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return;
      if (prod && (st.uid !== input.uid || st.nlink > 1)) {
        warn(`${display}: not the project's own file, skipped`);
        return;
      }
      if (mainGid !== undefined && st.gid !== mainGid) {
        fs.fchownSync(fd, st.uid, mainGid);
        result.changed += 1;
      }
      const want = (st.mode & 0o777) | 0o040; // g+r; setuid/setgid dropped
      if ((st.mode & 0o7777) !== want) {
        fs.fchmodSync(fd, want);
        result.changed += 1;
      }
    } finally {
      fs.closeSync(fd);
    }
  };

  const walk = (dirFd: number, dirPath: string, depth: number): void => {
    const listing = fs.opendirSync(procFd ? `/proc/self/fd/${dirFd}` : dirPath);
    try {
      for (let entry = listing.readSync(); entry !== null; entry = listing.readSync()) {
        if (result.visited >= maxEntries) {
          result.truncated = true;
          return;
        }
        result.visited += 1;
        const child = at(dirFd, dirPath, entry.name);
        const display = path.join(dirPath, entry.name);
        try {
          const st = fs.lstatSync(child);
          if (st.isDirectory()) {
            if (depth >= maxDepth) continue;
            const fd = openDir(dirFd, dirPath, entry.name);
            if (fd === null) continue;
            try {
              if (shareDir(fd, display)) walk(fd, display, depth + 1);
            } finally {
              fs.closeSync(fd);
            }
            if (result.truncated) return;
          } else if (st.isFile()) {
            // Nothing to do (the common case on later passes): not even opened.
            if ((st.mode & 0o040) && (mainGid === undefined || st.gid === mainGid) && !(st.mode & 0o6000)) continue;
            shareFile(child, display);
          }
          // Symlinks, FIFOs, sockets, devices: never touched.
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') warn(`${display}: ${(error as Error).message}`);
        }
      }
    } finally {
      listing.closeSync();
    }
  };

  const home = expectedHome(input.projectId, config);
  let homeFd: number;
  try {
    homeFd = fs.openSync(home, DIR_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw new RejectedError(`homeDir: ${(error as Error).message}`);
  }
  try {
    const claudeFd = openDir(homeFd, home, '.claude');
    if (claudeFd === null) return result;
    const claudePath = path.join(home, '.claude');
    try {
      if (!shareDir(claudeFd, claudePath)) return result;
      const projectsFd = openDir(claudeFd, claudePath, 'projects');
      if (projectsFd === null) return result;
      const projectsPath = path.join(claudePath, 'projects');
      try {
        if (shareDir(projectsFd, projectsPath)) walk(projectsFd, projectsPath, 0);
      } finally {
        fs.closeSync(projectsFd);
      }
    } finally {
      fs.closeSync(claudeFd);
    }
  } finally {
    fs.closeSync(homeFd);
  }
  return result;
}

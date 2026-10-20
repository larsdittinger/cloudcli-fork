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
export function validateSpawn(req: SpawnRequest, store: ProjectStore, config: PathConfig): void {
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
}

type TreeOptions = { uid: number; gid: number; chown: boolean; warnings: string[] };

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
    const base = hasProcFd ? `/proc/self/fd/${dirFd}` : dirPath;
    for (const name of fs.readdirSync(base)) {
      const child = `${base}/${name}`;
      const display = path.join(dirPath, name);
      try {
        const st = fs.lstatSync(child);
        if (st.isSymbolicLink()) {
          if (opts.chown) fs.lchownSync(child, opts.uid, opts.gid);
        } else if (st.isDirectory()) {
          applyTree(hasProcFd ? child : display, opts);
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
  config: PathConfig & { dev: boolean; mainGid?: number },
): { warnings: string[] } {
  if (!Number.isInteger(input.uid) || input.uid < MIN_ISOLATED_UID) throw new RejectedError(`uid below ${MIN_ISOLATED_UID}`);
  const real = resolveProjectDir(input.projectDir, config);
  const home = expectedHome(input.projectId, config);
  if (path.resolve(input.homeDir) !== home) throw new RejectedError('homeDir is not the project home');
  const chown = !config.dev;
  const opts: TreeOptions = { uid: input.uid, gid: config.mainGid ?? 0, chown, warnings: [] };

  fs.mkdirSync(home, { recursive: true });
  if (!fs.lstatSync(home).isDirectory()) throw new RejectedError('homeDir is not a directory');

  // The home is agent-writable: never read or write .claude.json through a planted symlink.
  const file = path.join(home, '.claude.json');
  let current: Record<string, unknown> = {};
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    try {
      const parsed = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed;
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
  return { warnings: opts.warnings };
}

// Files of isolated projects (<isolatedRoot>/<slug>) and their homes (<isolatedHomes>/<id>) are written by the
// agent, so whatever the main app does there must not follow a planted symlink out of the tree (disclosure, or a
// write into the app's own files) and must not block on a FIFO. Every access opens the path component by component
// from the deployment-owned root with O_NOFOLLOW, relative to the previous directory's fd (/proc/self/fd/<fd>/<name>
// on Linux; path based where procfs is missing, i.e. macOS dev), and checks the type of what it opened.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { FileTreeFileSystem } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';
import { daemonClient } from '@/modules/isolation/daemon-client.js';
import { isolationConfig } from '@/modules/isolation/isolation.config.js';
import { isIsolatedPath, isolationDb, type IsolatedProject } from '@/modules/isolation/isolation.db.js';

const hasProcFd = fs.existsSync('/proc/self/fd');
const C = fs.constants;
const DIR_FLAGS = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW;
// O_NONBLOCK: opening a FIFO would otherwise wait for the other side (and pin a threadpool worker or the loop).
const OPEN_FLAGS = {
  read: C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK,
  write: C.O_WRONLY | C.O_CREAT | C.O_TRUNC | C.O_NOFOLLOW | C.O_NONBLOCK,
  create: C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW | C.O_NONBLOCK,
} as const;
/** Mode of files and directories the app creates in an isolated project (group = the app's gid, see the daemon). */
const FILE_MODE = 0o660;
const DIR_MODE = 0o770;
/** Deeper trees are not removed (each level holds a directory fd). */
const MAX_REMOVE_DEPTH = 256;

export type IsolatedOpenMode = 'read' | 'dir' | 'write' | 'create';

/** A symlink, FIFO, socket or device where a plain file or directory of an isolated tree was expected. */
export class IsolatedPathRefusedError extends AppError {
  constructor(message: string) {
    super(message, { code: 'ISOLATED_PATH_REFUSED', statusCode: 403 });
    this.name = 'IsolatedPathRefusedError';
  }
}

const refused = (target: string, why: string) =>
  new IsolatedPathRefusedError(`${target}: ${why} — symbolic links and special files of isolated projects are not opened.`);

const errnoError = (code: string, target: string) =>
  Object.assign(new Error(`${code}: ${target}`), { code });

function splitRelative(rel: string, target: string): string[] {
  if (rel === '') return [];
  const parts = rel.split(path.sep);
  if (path.isAbsolute(rel) || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))) {
    throw refused(target, 'not a plain path inside the isolated tree');
  }
  return parts;
}

type DirHandle = { fd: number; dirPath: string };

const entryAt = (dir: DirHandle, name: string) => (hasProcFd ? `/proc/self/fd/${dir.fd}/${name}` : path.join(dir.dirPath, name));

/** Maps an open() failure: ENOENT/EACCES/… stay as they are, a symlink or special file is a refusal. */
function openFailure(error: unknown, target: string): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'ENXIO' || code === 'EMLINK' || code === 'EOPNOTSUPP' || code === 'EFTYPE') {
    return refused(target, `not a plain ${code === 'ENOTDIR' ? 'directory' : 'file'} (${code})`);
  }
  return error as Error;
}

/** Opens `root` (trusted) and every directory in `parts` below it without following symlinks. */
function openDirChain(root: string, parts: string[]): DirHandle {
  let dir: DirHandle = { fd: fs.openSync(root, C.O_RDONLY | C.O_DIRECTORY), dirPath: root };
  try {
    for (const part of parts) {
      let next: number;
      try {
        next = fs.openSync(entryAt(dir, part), DIR_FLAGS);
      } catch (error) {
        throw openFailure(error, path.join(dir.dirPath, part));
      }
      fs.closeSync(dir.fd);
      dir = { fd: next, dirPath: path.join(dir.dirPath, part) };
    }
    return dir;
  } catch (error) {
    fs.closeSync(dir.fd);
    throw error;
  }
}

/** Runs `fn` with the parent directory of `root/rel` opened safely and the entry's name; closes the parent after. */
function withParent<T>(root: string, rel: string, fn: (parent: DirHandle, name: string, target: string) => T): T {
  const target = path.join(root, rel);
  const parts = splitRelative(rel, target);
  if (parts.length === 0) throw refused(target, 'the isolated root itself');
  const parent = openDirChain(root, parts.slice(0, -1));
  try {
    return fn(parent, parts[parts.length - 1], target);
  } finally {
    fs.closeSync(parent.fd);
  }
}

/**
 * Opens `rel` below `root` (a directory the deployment owns, e.g. the isolated root or the homes root) without
 * following a symlink in any component. Modes: 'read' (a regular file, O_NONBLOCK), 'dir' (a directory),
 * 'write' (a regular file, created or truncated), 'create' (a new regular file, EEXIST otherwise). Returns the fd;
 * throws IsolatedPathRefusedError for a symlink or special file, the original error for ENOENT and the like.
 */
export function openIsolatedPath(root: string, rel: string, mode: IsolatedOpenMode): number {
  const target = path.join(root, rel);
  const parts = splitRelative(rel, target);
  if (mode === 'dir') return openDirChain(root, parts).fd;
  return withParent(root, rel, (parent, name) => {
    let fd: number;
    try {
      fd = mode === 'read' ? fs.openSync(entryAt(parent, name), OPEN_FLAGS.read) : fs.openSync(entryAt(parent, name), OPEN_FLAGS[mode], FILE_MODE);
    } catch (error) {
      throw openFailure(error, target);
    }
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) {
      fs.closeSync(fd);
      if (stats.isDirectory()) throw errnoError('EISDIR', target);
      throw refused(target, 'not a regular file');
    }
    return fd;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Which paths are "isolated"

const realRoots = new Map<string, string>();
function rootForms(root: string): string[] {
  const resolved = path.resolve(root);
  let real = realRoots.get(resolved);
  if (real === undefined) {
    try {
      real = fs.realpathSync(resolved);
      realRoots.set(resolved, real);
    } catch {
      real = resolved; // not created yet: compare as given, look again next time
    }
  }
  return real === resolved ? [resolved] : [resolved, real];
}

let dbRootsCache: { at: number; roots: string[] } | null = null;
/** Without the env (isolation switched off) the parents of the projects the DB still calls isolated (fail closed). */
function dbRoots(): string[] {
  const now = Date.now();
  if (!dbRootsCache || now - dbRootsCache.at > 2000) {
    let roots: string[] = [];
    try {
      roots = [...new Set(isolationDb.listIsolated().map((project) => path.dirname(path.resolve(project.projectPath))))];
    } catch {
      roots = [];
    }
    dbRootsCache = { at: now, roots };
  }
  return dbRootsCache.roots;
}

function areaRoots(): string[] {
  const config = isolationConfig();
  const roots = [config.isolatedRoot, config.isolatedHomes].filter(Boolean);
  return config.isolatedRoot ? roots : [...roots, ...dbRoots()];
}

/**
 * The isolated tree `target` lies in, by its path alone (no symlink is resolved, a planted one cannot move the path
 * out): `root` is the isolated root or the homes root as written in the path, `rel` the rest. Null outside.
 */
export function isolatedAreaOf(target: string): { root: string; rel: string } | null {
  if (typeof target !== 'string' || !target || target.includes('\0')) return null;
  const absolute = path.resolve(target);
  for (const root of areaRoots()) {
    for (const form of rootForms(root)) {
      const rel = path.relative(form, absolute);
      if (rel === '') return { root: form, rel };
      if (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) return { root: form, rel };
    }
  }
  return null;
}

/** Whether `target` is in an isolated tree by its path, or resolves into one (a symlink from elsewhere). */
export function touchesIsolatedArea(target: string): boolean {
  if (typeof target !== 'string' || !target.trim()) return false;
  return isolatedAreaOf(target) !== null || isIsolatedPath(target);
}

function requireArea(target: string): { root: string; rel: string } {
  const area = isolatedAreaOf(target);
  if (!area) throw refused(target, 'not inside an isolated tree');
  return area;
}

/** The isolated project whose directory holds `target`, by path (the daemon re-checks without following links). */
function projectOfPath(target: string): IsolatedProject | null {
  const absolute = path.resolve(target);
  let best: IsolatedProject | null = null;
  for (const project of isolationDb.listIsolated()) {
    const dir = path.resolve(project.projectPath);
    const rel = path.relative(dir, absolute);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) {
      if (!best || dir.length > path.resolve(best.projectPath).length) best = project;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Operations on absolute paths in an isolated tree

async function readFd(fd: number, maxBytes: number, target: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    if (fs.fstatSync(fd).size > maxBytes) throw tooLarge(target, maxBytes);
    for (;;) {
      const buffer = Buffer.alloc(Math.min(1024 * 1024, maxBytes + 1 - total));
      const bytesRead = await new Promise<number>((resolve, reject) => {
        fs.read(fd, buffer, 0, buffer.length, null, (error, count) => (error ? reject(error) : resolve(count)));
      });
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      if (total > maxBytes) throw tooLarge(target, maxBytes); // grew while it was read
    }
    return Buffer.concat(chunks);
  } finally {
    fs.closeSync(fd);
  }
}

const tooLarge = (target: string, maxBytes: number) =>
  new AppError(`${target} is too large to open here (over ${Math.round(maxBytes / (1024 * 1024)) || 1} MB).`, {
    code: 'FILE_TOO_LARGE',
    statusCode: 413,
  });

function lstatAt(target: string): fs.Stats {
  const { root, rel } = requireArea(target);
  if (rel === '') return fs.lstatSync(root);
  return withParent(root, rel, (parent, name) => fs.lstatSync(entryAt(parent, name)));
}

/** Recursively removes the entry `name` of `parent` without ever following a symlink (they are unlinked). */
function removeEntry(parent: DirHandle, name: string, depth: number): void {
  const at = entryAt(parent, name);
  if (!fs.lstatSync(at).isDirectory()) {
    fs.unlinkSync(at);
    return;
  }
  if (depth >= MAX_REMOVE_DEPTH) throw new AppError(`${path.join(parent.dirPath, name)} nests too deep to delete here.`, { code: 'TREE_TOO_DEEP', statusCode: 400 });
  let fd: number;
  try {
    fd = fs.openSync(at, DIR_FLAGS);
  } catch (error) {
    throw openFailure(error, path.join(parent.dirPath, name));
  }
  const dir: DirHandle = { fd, dirPath: path.join(parent.dirPath, name) };
  try {
    for (const child of fs.readdirSync(hasProcFd ? `/proc/self/fd/${fd}` : dir.dirPath)) removeEntry(dir, child, depth + 1);
  } finally {
    fs.closeSync(fd);
  }
  fs.rmdirSync(at);
}

export const isolatedFs = {
  /** lstat semantics: a symlink is reported as one, never followed. */
  async lstat(target: string): Promise<fs.Stats> {
    return lstatAt(target);
  },

  /** A regular file's bytes, at most `maxBytes` (413 beyond). */
  async readText(target: string, maxBytes: number): Promise<Buffer> {
    const { root, rel } = requireArea(target);
    return readFd(openIsolatedPath(root, rel, 'read'), maxBytes, target);
  },

  /** A read stream over a regular file (opened now, so a refusal throws here). */
  createReadStream(target: string): fs.ReadStream {
    const { root, rel } = requireArea(target);
    const fd = openIsolatedPath(root, rel, 'read');
    return fs.createReadStream(target, { fd, autoClose: true });
  },

  /** The entries of a directory (lstat types: a symlink is not a directory). */
  async *listDirectory(target: string): AsyncGenerator<fs.Dirent> {
    const { root, rel } = requireArea(target);
    const fd = openIsolatedPath(root, rel, 'dir');
    let listing: fs.Dir;
    try {
      listing = await fsp.opendir(hasProcFd ? `/proc/self/fd/${fd}` : target);
    } finally {
      fs.closeSync(fd);
    }
    yield* listing;
  },

  /** Creates or truncates a regular file and writes `content`. */
  async writeText(target: string, content: string): Promise<void> {
    const { root, rel } = requireArea(target);
    const fd = openIsolatedPath(root, rel, 'write');
    try {
      await new Promise<void>((resolve, reject) => {
        fs.writeFile(fd, content, 'utf8', (error) => (error ? reject(error) : resolve()));
      });
    } finally {
      fs.closeSync(fd);
    }
  },

  /** Copies a file from outside (an upload's temp file) into the isolated tree. */
  async copyInto(source: string, target: string): Promise<void> {
    const { root, rel } = requireArea(target);
    const fd = openIsolatedPath(root, rel, 'write');
    await pipeline(fs.createReadStream(source), fs.createWriteStream(target, { fd, autoClose: true }));
  },

  /** mkdir (-p with `recursive`). Returns the topmost directory it created, null when nothing was created. */
  async makeDirectory(target: string, recursive: boolean): Promise<string | null> {
    const { root, rel } = requireArea(target);
    const parts = splitRelative(rel, target);
    let dir: DirHandle = { fd: fs.openSync(root, C.O_RDONLY | C.O_DIRECTORY), dirPath: root };
    let created: string | null = null;
    try {
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        const last = index === parts.length - 1;
        const at = entryAt(dir, part);
        let next: number;
        try {
          next = fs.openSync(at, DIR_FLAGS);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw openFailure(error, path.join(dir.dirPath, part));
          if (!last && !recursive) throw error;
          fs.mkdirSync(at, DIR_MODE); // never follows: an existing symlink of that name is EEXIST
          created ??= path.join(dir.dirPath, part);
          next = fs.openSync(at, DIR_FLAGS);
        }
        if (last && !recursive && !created) {
          fs.closeSync(next);
          throw errnoError('EEXIST', target);
        }
        fs.closeSync(dir.fd);
        dir = { fd: next, dirPath: path.join(dir.dirPath, part) };
      }
      return created;
    } finally {
      fs.closeSync(dir.fd);
    }
  },

  /** rename(2) of the entry itself (a symlink is moved as a link), both ends inside the same isolated tree. */
  async rename(from: string, to: string): Promise<void> {
    const source = requireArea(from);
    const destination = requireArea(to);
    if (source.root !== destination.root) throw refused(to, 'outside the tree of the source');
    withParent(source.root, source.rel, (sourceParent, sourceName) => {
      withParent(destination.root, destination.rel, (destinationParent, destinationName) => {
        fs.renameSync(entryAt(sourceParent, sourceName), entryAt(destinationParent, destinationName));
      });
    });
  },

  /** unlink(2) of the entry itself. */
  async unlink(target: string): Promise<void> {
    const { root, rel } = requireArea(target);
    withParent(root, rel, (parent, name) => fs.unlinkSync(entryAt(parent, name)));
  },

  /** rm -rf without following symlinks (they are unlinked, their targets stay). A missing entry is no error. */
  async removeTree(target: string): Promise<void> {
    const { root, rel } = requireArea(target);
    withParent(root, rel, (parent, name) => {
      try {
        removeEntry(parent, name, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
  },

  /**
   * Hands an entry the app created in an isolated project to the project's uid (the daemon chowns it without
   * following links), so the agent can use it. Best effort: without the daemon the file stays the app's.
   */
  async adopt(target: string | null): Promise<void> {
    if (!target) return;
    const project = projectOfPath(target);
    if (!project) return;
    const rel = path.relative(path.resolve(project.projectPath), path.resolve(target));
    if (!rel) return;
    try {
      await daemonClient.adopt(project, [rel.split(path.sep).join('/')]);
    } catch (error) {
      console.warn(`[Isolation] ${target} stays owned by the app, the sandbox did not take it over: ${(error as Error).message}`);
    }
  },
};

/** Cap of a text file the Files tab opens from an isolated tree. */
export const ISOLATED_TEXT_FILE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The File Tree's filesystem adapter with every path in an isolated tree going through isolatedFs (decided by the
 * path alone, see isolatedAreaOf); other paths use `base` unchanged. Entries the app creates in an isolated project
 * are handed to the project's uid.
 */
export function withIsolatedFileSystem(base: FileTreeFileSystem): FileTreeFileSystem {
  const inArea = (target: string) => isolatedAreaOf(target) !== null;
  return {
    async access(target) {
      if (!inArea(target)) return base.access(target);
      await isolatedFs.lstat(target);
    },
    stat: (target) => (inArea(target) ? isolatedFs.lstat(target) : base.stat(target)),
    lstat: (target) => (inArea(target) ? isolatedFs.lstat(target) : base.lstat(target)),
    openDirectory: (target) => (inArea(target) ? isolatedFs.listDirectory(target) : base.openDirectory(target)),
    realpath: (target) => base.realpath(target),
    async readTextFile(target) {
      if (!inArea(target)) return base.readTextFile(target);
      return (await isolatedFs.readText(target, ISOLATED_TEXT_FILE_MAX_BYTES)).toString('utf8');
    },
    async writeTextFile(target, content) {
      if (!inArea(target)) return base.writeTextFile(target, content);
      await isolatedFs.writeText(target, content);
      await isolatedFs.adopt(target);
    },
    async makeDirectory(target, recursive) {
      if (!inArea(target)) return base.makeDirectory(target, recursive);
      await isolatedFs.adopt(await isolatedFs.makeDirectory(target, recursive));
    },
    async rename(from, to) {
      if (!inArea(from) && !inArea(to)) return base.rename(from, to);
      await isolatedFs.rename(from, to);
    },
    async removeDirectory(target) {
      if (!inArea(target)) return base.removeDirectory(target);
      await isolatedFs.removeTree(target);
    },
    async unlink(target) {
      if (!inArea(target)) return base.unlink(target);
      await isolatedFs.unlink(target);
    },
    async copyFile(source, destination) {
      if (!inArea(source) && !inArea(destination)) return base.copyFile(source, destination);
      if (inArea(source)) throw refused(source, 'not copied out of an isolated tree');
      await isolatedFs.copyInto(source, destination);
      await isolatedFs.adopt(destination);
    },
    createReadStream: (target) => (inArea(target) ? isolatedFs.createReadStream(target) : base.createReadStream(target)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Main-side tools that must not run in isolated trees at all

/** 409 for a feature that runs tools or reads config in a project from the main process. */
export function isolatedFeatureRefused(feature: string): AppError {
  return new AppError(`${feature} is not available for isolated projects.`, { code: 'ISOLATED_PROJECT_UNSUPPORTED', statusCode: 409 });
}

/** Throws isolatedFeatureRefused when any of `paths` is in (or resolves into) an isolated tree. */
export function assertOutsideIsolatedArea(paths: Array<string | null | undefined>, feature: string): void {
  if (paths.some((target) => typeof target === 'string' && touchesIsolatedArea(target))) throw isolatedFeatureRefused(feature);
}

type SpawnLike = (command: string, args?: readonly string[], options?: { cwd?: string | URL } & Record<string, unknown>) => unknown;

/**
 * A spawn that refuses (the child emits 'error' on the next tick) when its cwd or any absolute path argument is in
 * an isolated tree — for main-side tools (git of /api/agent, worktrees…) that have no business there.
 */
export function refuseSpawnInIsolatedArea<T extends SpawnLike>(spawn: T, feature: string): T {
  return ((command: string, args: readonly string[] = [], options: Parameters<SpawnLike>[2] = {}) => {
    const cwd = typeof options?.cwd === 'string' ? options.cwd : undefined;
    const absoluteArgs = args.filter((arg) => typeof arg === 'string' && path.isAbsolute(arg));
    if ((cwd && touchesIsolatedArea(cwd)) || absoluteArgs.some((arg) => touchesIsolatedArea(arg))) {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        kill: () => true,
      });
      process.nextTick(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('error', isolatedFeatureRefused(feature));
      });
      return child;
    }
    return spawn(command, args, options);
  }) as T;
}

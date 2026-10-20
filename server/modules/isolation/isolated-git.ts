// Git of isolated projects. Their .git (config, hooks) is written by the agent — core.fsmonitor, core.pager,
// diff.external or a hook would run anything as the app — so the main process never runs git there. The Git routes
// of an isolated project get a spawn that runs git in the sandbox as the project's uid (no Claude login, no
// credentials) and a filesystem that never follows a symlink; routes that need credentials are refused.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import express from 'express';

import { isolatedFs, IsolatedPathRefusedError, touchesIsolatedArea } from '@/modules/isolation/isolated-fs.js';
import { isolationDb, type IsolatedProject } from '@/modules/isolation/isolation.db.js';
import { runInSandbox } from '@/modules/isolation/sandbox-exec.js';

export const GIT_ISOLATED_REFUSED_TEXT = 'Git is not available for isolated projects.';
/** They need the app's Git credentials (the sandbox has none and must not get them). */
const REFUSED_ROUTES = new Set(['/fetch', '/pull', '/push', '/publish']);
/** Commits made from the app's Git panel; never the app user's own Git identity. */
const GIT_IDENTITY = { name: 'CloudCLI', email: 'cloudcli@localhost' };
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const GIT_MAX_FILE_BYTES = 8 * 1024 * 1024;

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const isInside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

type GitChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(): boolean };

/**
 * A cross-spawn lookalike for the Git routes of one isolated project: `git <args>` runs in the sandbox as the
 * project's uid, in `cwd` — which must lie in that project (git output such as --show-toplevel is the agent's and
 * could name any directory). Emits 'close' with the exit code, or 'error'.
 */
export function createSandboxGitSpawn(project: IsolatedProject) {
  return (command: string, args: string[], options: { cwd?: string } = {}): GitChild => {
    const abort = new AbortController();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        abort.abort();
        return true;
      },
    });
    const fail = (error: Error) => process.nextTick(() => child.emit('error', error));
    const cwd = path.resolve(options.cwd ?? project.projectPath);
    if (command !== 'git') {
      fail(new Error(`Only git runs for an isolated project, not ${command}.`));
      return child;
    }
    if (!isInside(cwd, path.resolve(project.projectPath)) || isolationDb.getByPath(cwd)?.projectId !== project.projectId) {
      fail(new IsolatedPathRefusedError(`${cwd}: git of an isolated project runs only inside that project`));
      return child;
    }

    let outputBytes = 0;
    let overflow = false;
    const capped = (stream: PassThrough) => (text: string) => {
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > GIT_MAX_OUTPUT_BYTES) {
        overflow = true;
        abort.abort();
        return;
      }
      stream.write(text);
    };
    const commandLine = ['exec', 'git', '-c', `user.name=${GIT_IDENTITY.name}`, '-c', `user.email=${GIT_IDENTITY.email}`, ...args]
      .map(shellQuote)
      .join(' ');
    // A project that cannot run in the sandbox rejects here and ends as 'error' (fail closed, never local).
    const run = runInSandbox({
      projectPath: cwd,
      command: commandLine,
      env: { GIT_TERMINAL_PROMPT: '0' },
      timeoutMs: GIT_TIMEOUT_MS,
      signal: abort.signal,
      onStdout: capped(child.stdout),
      onStderr: capped(child.stderr),
    });
    run.then(
      async (result) => {
        child.stdout.end();
        child.stderr.end();
        // The routes collect output from 'data' events: let both streams drain before reporting the exit.
        await Promise.all([child.stdout, child.stderr].map((stream) => new Promise<void>((resolve) => {
          if (stream.readableEnded) return resolve();
          const timer = setTimeout(resolve, 1000);
          stream.once('end', () => {
            clearTimeout(timer);
            resolve();
          });
        })));
        if (overflow) child.emit('error', new Error(`git printed more than ${GIT_MAX_OUTPUT_BYTES} bytes in the sandbox`));
        else if (result.timedOut) child.emit('error', new Error(`git did not finish in the sandbox within ${GIT_TIMEOUT_MS / 1000} s`));
        else child.emit('close', result.exitCode ?? 1);
      },
      (error: Error) => child.emit('error', error),
    );
    return child;
  };
}

/**
 * The part of node:fs/promises the Git routes use, for one isolated project: lstat semantics, no symlink followed,
 * no FIFO opened, file reads capped, and nothing outside the project.
 */
export function createIsolatedGitFileSystem(project: IsolatedProject) {
  const inProject = (target: string) => {
    const absolute = path.resolve(target);
    if (!isInside(absolute, path.resolve(project.projectPath))) {
      throw new IsolatedPathRefusedError(`${absolute}: outside the isolated project`);
    }
    return absolute;
  };
  return {
    access: async (target: string) => {
      await isolatedFs.lstat(inProject(target));
    },
    stat: (target: string) => isolatedFs.lstat(inProject(target)),
    lstat: (target: string) => isolatedFs.lstat(inProject(target)),
    readFile: async (target: string, encoding?: BufferEncoding | { encoding?: BufferEncoding }) => {
      const bytes = await isolatedFs.readText(inProject(target), GIT_MAX_FILE_BYTES);
      const chosen = typeof encoding === 'string' ? encoding : encoding?.encoding;
      return chosen ? bytes.toString(chosen) : bytes;
    },
    rm: (target: string) => isolatedFs.removeTree(inProject(target)),
    unlink: (target: string) => isolatedFs.unlink(inProject(target)),
  };
}

export type IsolatedGitDependencies = {
  spawnProcess: ReturnType<typeof createSandboxGitSpawn>;
  fileSystem: ReturnType<typeof createIsolatedGitFileSystem>;
};

/**
 * The project a Git request names. The routes read `project` from the query (GET) or the body (POST), so both are
 * looked at: a non-string value or two different values is a 400, never a guess (a mismatch could send the
 * request past this guard while the route acts on the other one).
 */
function readProjectId(request: express.Request): { projectId: string | null } | { error: string } {
  const candidates = [request.query?.project, (request.body as { project?: unknown } | undefined)?.project]
    .filter((value) => value !== undefined && value !== null && value !== '');
  if (candidates.some((value) => typeof value !== 'string')) return { error: 'Invalid project id' };
  const ids = [...new Set(candidates as string[])];
  if (ids.length > 1) return { error: 'The project in the query and in the body differ' };
  return { projectId: ids[0] ?? null };
}

/** Express matches routes case-insensitively and ignores a trailing slash; so does this check. */
const routeOf = (requestPath: string) => requestPath.toLowerCase().replace(/\/+$/, '') || '/';

/**
 * Wraps the Git router: a request for an isolated project goes to a router built with `createIsolatedRouter`
 * (sandbox spawn + safe filesystem, cached per project), or gets 409 when it needs credentials or the project
 * cannot be resolved to an isolated project; everything else goes to `router` unchanged.
 */
export function guardIsolatedGit(
  router: express.Router,
  options: {
    resolveProjectPathById(projectId: string): string | null | Promise<string | null>;
    createIsolatedRouter(dependencies: IsolatedGitDependencies): express.Router;
  },
): express.Router {
  const isolatedRouters = new Map<string, { key: string; router: express.Router }>();
  const guard = express.Router();
  guard.use(async (request, response, next) => {
    try {
      const requested = readProjectId(request);
      if ('error' in requested) {
        response.status(400).json({ success: false, error: requested.error });
        return;
      }
      const { projectId } = requested;
      const projectPath = projectId ? await options.resolveProjectPathById(projectId) : null;
      if (!projectPath || !touchesIsolatedArea(projectPath)) {
        router(request, response, next);
        return;
      }
      const project = isolationDb.getByPath(projectPath);
      if (!project || REFUSED_ROUTES.has(routeOf(request.path))) {
        response.status(409).json({ success: false, error: GIT_ISOLATED_REFUSED_TEXT });
        return;
      }
      const key = `${project.uid}:${project.projectPath}:${project.homeDir}`;
      let cached = isolatedRouters.get(project.projectId);
      if (!cached || cached.key !== key) {
        cached = {
          key,
          router: options.createIsolatedRouter({
            spawnProcess: createSandboxGitSpawn(project),
            fileSystem: createIsolatedGitFileSystem(project),
          }),
        };
        isolatedRouters.set(project.projectId, cached);
      }
      cached.router(request, response, next);
    } catch (error) {
      next(error);
    }
  });
  return guard;
}

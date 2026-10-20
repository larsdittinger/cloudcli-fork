import * as fs from 'node:fs/promises';
import os from 'node:os';

import express from 'express';

import { canAccessProjectPath } from '@/modules/auth/index.js';
import { isolatedAreaOf, isolatedFs } from '@/modules/isolation/index.js';
import { providerModelsService } from '@/modules/providers/index.js';
import { findApplicationRoot, getModuleDirectory, readProjectTextFile } from '@/shared/utils.js';

import { createCommandsRouter } from './commands.routes.js';

type CommandsRequest = express.Request & { user?: Parameters<typeof canAccessProjectPath>[0] };

/**
 * `/list` scans `<projectPath>/.claude/commands` and `/execute` reads a command
 * file under `context.projectPath`, so a restricted user may name only a
 * project they were granted. Kept outside the upstream router file.
 */
function guardCommandProjectPaths(req: CommandsRequest, res: express.Response, next: express.NextFunction): void {
  const body = (req.body ?? {}) as { projectPath?: unknown; context?: { projectPath?: unknown } };
  for (const projectPath of [body.projectPath, body.context?.projectPath]) {
    if (typeof projectPath === 'string' && projectPath && !canAccessProjectPath(req.user, projectPath)) {
      res.status(403).json({ error: 'Project access denied', code: 'PROJECT_ACCESS_DENIED' });
      return;
    }
  }
  next();
}

const MAX_COMMAND_FILE_BYTES = 1024 * 1024;

/**
 * An isolated project's `.claude/commands` is the agent's: its files are read without following a symlink (a link
 * to an app secret would end up in the prompt) or blocking on a FIFO, and its directories are listed the same way.
 */
const commandsFileSystem = {
  ...fs,
  readFile: ((filePath: string, encoding?: BufferEncoding) =>
    readProjectTextFile(filePath, MAX_COMMAND_FILE_BYTES, (target) => fs.readFile(target, encoding ?? 'utf8'))) as typeof fs.readFile,
  readdir: (async (dirPath: string, options?: Parameters<typeof fs.readdir>[1]) => {
    if (!isolatedAreaOf(dirPath)) return fs.readdir(dirPath, options as never);
    const entries: import('node:fs').Dirent[] = [];
    for await (const entry of isolatedFs.listDirectory(dirPath)) entries.push(entry);
    return (options as { withFileTypes?: boolean } | undefined)?.withFileTypes ? entries : entries.map((entry) => entry.name);
  }) as typeof fs.readdir,
} as typeof fs;

/** Commands router assembled for the authenticated server mount. */
export const commandsRoutes = express.Router().use(guardCommandProjectPaths, createCommandsRouter({
  fileSystem: commandsFileSystem,
  homeDirectory: os.homedir,
  appRoot: findApplicationRoot(getModuleDirectory(import.meta.url)),
  models: providerModelsService,
  runtime: {
    uptime: process.uptime,
    memoryUsage: process.memoryUsage,
    version: process.version,
    platform: process.platform,
    pid: process.pid,
  },
}));

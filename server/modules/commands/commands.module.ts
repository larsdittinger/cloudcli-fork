import * as fs from 'node:fs/promises';
import os from 'node:os';

import express from 'express';

import { canAccessProjectPath } from '@/modules/auth/index.js';
import { providerModelsService } from '@/modules/providers/index.js';
import { findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';

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

/** Commands router assembled for the authenticated server mount. */
export const commandsRoutes = express.Router().use(guardCommandProjectPaths, createCommandsRouter({
  fileSystem: fs,
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

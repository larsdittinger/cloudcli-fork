import fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import os from 'node:os';

import spawn from 'cross-spawn';
import express from 'express';

import { projectsDb } from '@/modules/database/index.js';
import { isolatedFeatureRefused, refuseSpawnInIsolatedArea, touchesIsolatedArea } from '@/modules/isolation/index.js';

import { createTaskmasterRouter } from './taskmaster.routes.js';
import { createTaskmasterService } from './taskmaster.service.js';

const taskmasterService = createTaskmasterService({
  readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
  getHomeDirectory: os.homedir,
});

/**
 * TaskMaster runs its CLI and reads `.taskmaster` in the project directory from the main process; an isolated
 * project's directory is its agent's, so every project route answers 409 there (`/<route>/:projectId[/…]`).
 */
const refuseIsolatedProjects: express.RequestHandler = (request, response, next) => {
  const projectId = request.path.split('/')[2];
  let projectPath: string | null = null;
  try {
    projectPath = projectId ? projectsDb.getProjectPathById(decodeURIComponent(projectId)) : null;
  } catch {
    projectPath = null;
  }
  if (projectPath && touchesIsolatedArea(projectPath)) {
    response.status(409).json({ success: false, error: isolatedFeatureRefused('TaskMaster').message });
    return;
  }
  next();
};

/** Used by the server entrypoint to mount authenticated TaskMaster endpoints. */
export const taskmasterRoutes = express.Router().use(refuseIsolatedProjects, createTaskmasterRouter({
  fileSystem: fs,
  fileSystemPromises: fsPromises,
  spawnProcess: refuseSpawnInIsolatedArea(spawn, 'TaskMaster'),
  resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  taskmasterService,
}));

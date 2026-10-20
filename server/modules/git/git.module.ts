import * as fs from 'node:fs/promises';

import spawn from 'cross-spawn';

import { projectsDb } from '@/modules/database/index.js';
import { guardIsolatedGit } from '@/modules/isolation/index.js';

import { createGitRouter } from './git.routes.js';

type GitExternalDependencies = Pick<
  Parameters<typeof createGitRouter>[0],
  'queryClaude' | 'queryCursor'
>;

/** Assembles the Git router with runners from the centralized provider runtime service. */
export function createGitModule(externalDependencies: GitExternalDependencies) {
  const dependencies: Parameters<typeof createGitRouter>[0] = {
    fileSystem: fs,
    spawnProcess: spawn,
    resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
    ...externalDependencies,
  };
  // An isolated project's git runs in its sandbox (its .git is the agent's), never in this process.
  return guardIsolatedGit(createGitRouter(dependencies), {
    resolveProjectPathById: dependencies.resolveProjectPathById,
    createIsolatedRouter: (isolated) => createGitRouter({ ...dependencies, ...(isolated as unknown as Pick<typeof dependencies, 'fileSystem' | 'spawnProcess'>) }),
  });
}

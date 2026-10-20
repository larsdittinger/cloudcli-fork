// Isolation — agents of isolated projects run in the sibling sandbox container (daemon/), under their own uid,
// with a network allowlist and only run-token scoped access back to the app (main.sock).
import path from 'node:path';

import { registerProjectFileGuard, registerReadOnlyRoots } from '@/shared/utils.js';

import { isolatedAreaOf, isolatedFs } from './isolated-fs.js';
import { claudeTranscriptRoots } from './isolation-transcripts.js';

// isolationRoutes: mounted by the server entrypoint at /api/isolation behind authenticateToken + requireAdmin.
export { default as isolationRoutes } from './isolation.routes.js';
// initializeIsolation / closeIsolation: called by the server entrypoint (main.sock + pushing projects to the daemon).
export { initializeIsolation, closeIsolation, isolationService } from './isolation.service.js';
export type { DaemonSync, PublicIsolatedProject } from './isolation.service.js';

export { isolationConfig, daemonSocketPath, mainSocketPath } from './isolation.config.js';
export type { IsolationConfig } from './isolation.config.js';
// isIsolatedPath: the single decision whether a path's runs must go to the sandbox (runtime, schedules, shell, channels).
export { isIsolatedPath, isolationDb, MIN_ISOLATED_UID } from './isolation.db.js';
export type { IsolatedProject, IsolationTools } from './isolation.db.js';
export { daemonClient, createDaemonClient, DaemonCallError, SandboxProcess, SANDBOX_DOWN_TEXT } from './daemon-client.js';
export type { BlockedEntry, DaemonClient, DaemonStatus, SelfCheckResult, SpawnRequest } from './daemon-client.js';
export { runTokens } from './run-tokens.js';
export type { RunChannelContext, RunTokenInfo, RunTokenInput, RunTokenPurpose } from './run-tokens.js';
// registerSandboxMcpRouter: lets Channels / Tasks plug their run-token scoped MCP routers into main.sock.
// createSandboxApiApp: main.sock's app; exported for integration tests of the modules that plug into it.
export { createSandboxApiApp, ISOLATED_DENIED_TEXT, registerSandboxMcpRouter, requireRunToken } from './sandbox-api.server.js';
export type { SandboxApiRequest, SandboxMcpKind, SandboxMcpScope } from './sandbox-api.server.js';
export { CLAUDE_LOGIN_MISSING, ISOLATION_CLAUDE_TOKEN_KEY } from './claude-proxy.js';
// Claude runs of isolated projects (runtime hook) and what they need around them.
export {
  applySandboxOptions,
  buildSandboxEnv,
  ISOLATED_CLAUDE_ONLY_TEXT,
  sandboxMcpDir,
} from './claude-sandbox-options.js';
export type { SandboxEnvOptions, SandboxRun, SandboxRunContext } from './claude-sandbox-options.js';
export { runInSandbox, startSandboxTerminal } from './sandbox-exec.js';
export type { SandboxExecResult, SandboxTerminal, ShellPty } from './sandbox-exec.js';
export { ATTACHMENTS_DIR, stageForSandbox } from './sandbox-attachments.js';
export {
  acceptTranscript,
  claudeTranscriptRoots,
  findIsolatedTranscripts,
  isIsolatedTranscriptPath,
  isolatedHomesRoot,
  isProviderSessionIdFree,
  isReadableTranscript,
  ISOLATED_TRANSCRIPT_LIMITS,
  openTranscriptStream,
  readTranscriptTail,
  readTranscriptText,
  startIsolatedTranscriptPoller,
  TranscriptRefusedError,
} from './isolation-transcripts.js';
// Main-side access to files of isolated projects and homes: never through a symlink, never blocking on a FIFO.
export {
  assertOutsideIsolatedArea,
  isolatedAreaOf,
  isolatedFeatureRefused,
  isolatedFs,
  IsolatedPathRefusedError,
  openIsolatedPath,
  refuseSpawnInIsolatedArea,
  touchesIsolatedArea,
  withIsolatedFileSystem,
} from './isolated-fs.js';
export type { IsolatedOpenMode } from './isolated-fs.js';
// guardIsolatedGit: the Git module routes isolated projects' git through the sandbox (or refuses it).
export { GIT_ISOLATED_REFUSED_TEXT, guardIsolatedGit } from './isolated-git.js';

// The file viewer follows transcript paths (background agent outputs) into isolated homes too.
registerReadOnlyRoots(() => claudeTranscriptRoots().slice(1));

// Config files, manifests and skills the app reads (and the MCP config it writes) inside isolated trees.
registerProjectFileGuard({
  claims: (filePath) => isolatedAreaOf(filePath) !== null,
  read: (filePath, maxBytes) => isolatedFs.readText(filePath, maxBytes),
  async write(filePath, content) {
    const created = await isolatedFs.makeDirectory(path.dirname(filePath), true);
    await isolatedFs.writeText(filePath, content);
    await isolatedFs.adopt(created ?? filePath);
  },
});

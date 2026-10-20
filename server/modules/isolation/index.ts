// Isolation — agents of isolated projects run in the sibling sandbox container (daemon/), under their own uid,
// with a network allowlist and only run-token scoped access back to the app (main.sock).

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
export { registerSandboxMcpRouter, requireRunToken } from './sandbox-api.server.js';
export type { SandboxApiRequest, SandboxMcpKind } from './sandbox-api.server.js';
export { CLAUDE_LOGIN_MISSING, ISOLATION_CLAUDE_TOKEN_KEY } from './claude-proxy.js';

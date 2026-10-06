// Tasks — long-running agent tasks: a card as the agent's memory, wake-ups, and replies routed from Channels.
import { closeChannelLink, initializeChannelLink } from '@/modules/tasks/channel-link.service.js';
import { closeTaskEngine, initializeTaskEngine, settleTaskRuns } from '@/modules/tasks/engine.service.js';
import { registerTasksMcp } from '@/modules/tasks/mcp-registration.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

// tasksRoutes: mounted by the server entrypoint behind authenticateToken + requireAdmin.
export { default as tasksRoutes } from '@/modules/tasks/tasks.routes.js';
// tasksMcpRoutes: the local bridge the cloudcli-tasks MCP server calls (own token, no user session).
export { default as tasksMcpRoutes } from '@/modules/tasks/tasks-mcp.routes.js';

/**
 * Used by the server entrypoint once at start, after Channels: links task
 * conversations, resumes interrupted runs, starts the engine and registers
 * the agents' MCP server.
 */
export async function initializeTasks(runtime: ProviderRuntimeGateway): Promise<void> {
  initializeChannelLink();
  initializeTaskEngine(runtime);
  await registerTasksMcp();
}

/** Used by the server entrypoint on shutdown. */
export async function closeTasks(): Promise<void> {
  closeTaskEngine();
  closeChannelLink();
  // Runs end with the process; give the ones finishing right now a moment to book their result.
  await Promise.race([settleTaskRuns(), new Promise((resolve) => setTimeout(resolve, 2000))]);
}

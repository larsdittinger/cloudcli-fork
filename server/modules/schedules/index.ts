// Schedules — recurring AI prompts (run as sidebar chats) and scripts.
import { createScheduleExecutor } from '@/modules/schedules/executor.service.js';
import { registerSchedulesMcp } from '@/modules/schedules/mcp-registration.service.js';
import { importCronPluginSchedules } from '@/modules/schedules/plugin-import.service.js';
import { disablePlugin } from '@/modules/plugins/index.js';
import { closeScheduler, initializeScheduler, settleRunningSchedules } from '@/modules/schedules/scheduler.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

// schedulesRoutes: mounted by the server entrypoint behind authenticateToken + requireAdmin.
export { default as schedulesRoutes } from '@/modules/schedules/schedules.routes.js';
// schedulesMcpRoutes: the local bridge the cloudcli-schedules MCP server calls (own token, no user session).
export { default as schedulesMcpRoutes } from '@/modules/schedules/schedules-mcp.routes.js';

/**
 * Used by the server entrypoint once at start, before plugin servers start:
 * imports the old cron plugin's tasks (once), recovers interrupted runs,
 * starts the ticker and registers the agents' MCP server.
 */
export async function initializeSchedules(runtime: ProviderRuntimeGateway): Promise<void> {
  try {
    await importCronPluginSchedules({ disablePlugin });
  } catch (error) {
    console.error('[Schedules] Import from the cron plugin failed', error);
  }
  initializeScheduler(createScheduleExecutor(runtime));
  await registerSchedulesMcp();
}

/** Used by the server entrypoint on shutdown. */
export async function closeSchedules(): Promise<void> {
  closeScheduler();
  // Runs end with the process anyway; give the ones finishing right now a moment to book their result.
  await Promise.race([settleRunningSchedules(), new Promise((resolve) => setTimeout(resolve, 2000))]);
}

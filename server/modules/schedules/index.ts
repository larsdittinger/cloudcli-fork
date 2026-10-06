// Schedules — recurring AI prompts (run as sidebar chats) and scripts.
import { createScheduleExecutor } from '@/modules/schedules/executor.service.js';
import { closeScheduler, initializeScheduler, settleRunningSchedules } from '@/modules/schedules/scheduler.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

// schedulesRoutes: mounted by the server entrypoint behind authenticateToken + requireAdmin.
export { default as schedulesRoutes } from '@/modules/schedules/schedules.routes.js';

/**
 * Used by the server entrypoint once at start, before plugin servers start:
 * recovers interrupted runs and starts the ticker.
 */
export async function initializeSchedules(runtime: ProviderRuntimeGateway): Promise<void> {
  initializeScheduler(createScheduleExecutor(runtime));
}

/** Used by the server entrypoint on shutdown. */
export async function closeSchedules(): Promise<void> {
  closeScheduler();
  // Runs end with the process anyway; give the ones finishing right now a moment to book their result.
  await Promise.race([settleRunningSchedules(), new Promise((resolve) => setTimeout(resolve, 2000))]);
}

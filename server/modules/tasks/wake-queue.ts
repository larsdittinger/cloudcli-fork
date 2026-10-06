import { tasksDb } from '@/modules/database/index.js';
import { broadcastTasksUpdated } from '@/modules/tasks/tasks-broadcast.js';

/** What the engine does when told about a wake or a deleted task; unset in tests that drive the engine by hand. */
type EngineHooks = { kick: () => void; abort: (taskId: number, sessionId: string) => void };

let hooks: EngineHooks | null = null;

/** Used by the task engine at start (and cleared on close). */
export function setEngineHooks(next: EngineHooks | null): void {
  hooks = next;
}

/**
 * Used by the tasks service and the channel link: queues a reason for the
 * task's next run and nudges the engine. A running task picks it up right
 * after its current run, so nothing is lost and nothing runs twice.
 */
export function queueWake(taskId: number, reason: string): void {
  tasksDb.addPendingWake(taskId, reason);
  broadcastTasksUpdated({ taskId });
  hooks?.kick();
}

/** Used by the tasks service when a task is deleted mid-run: stops the agent's turn. */
export function abortTaskRun(taskId: number, sessionId: string): void {
  hooks?.abort(taskId, sessionId);
}

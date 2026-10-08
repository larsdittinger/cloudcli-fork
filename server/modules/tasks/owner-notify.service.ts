import { userDb } from '@/modules/database/index.js';
import type { TaskRow } from '@/modules/database/index.js';
import { createNotificationEvent, notifyUserIfEnabled } from '@/modules/notifications/index.js';

/** One thing about a task the owner should hear about away from the open app. */
export type TaskNotice = {
  taskId: number;
  title: string;
  message: string;
  /** True when the task waits for the owner (a question, a mandate, a draft), false for news (done, cancelled). */
  needsAction: boolean;
  /** Collapses repeats of the same news for the same task. */
  kind: string;
};

let testNotifier: ((notice: TaskNotice) => void) | null = null;

/** @internal test hook: record notices instead of delivering them. */
export function setTaskNotifierForTests(notifier: ((notice: TaskNotice) => void) | null): void {
  testNotifier = notifier;
}

/** The task's owner, or every admin when an agent created it on nobody's behalf. */
function recipients(task: TaskRow): number[] {
  if (task.owner_user_id) return [task.owner_user_id];
  return userDb.listUsers().filter((user) => user.role !== 'restricted').map((user) => user.id);
}

/**
 * Used by the tasks service: tells the owner through their enabled
 * notification channels (web push, desktop) that a task needs them or ended,
 * so a question does not wait until someone happens to open the app. The
 * notification opens the task card (`/?task=N`).
 */
export function notifyTaskOwner(task: TaskRow, notice: Omit<TaskNotice, 'taskId' | 'title'>): void {
  const full: TaskNotice = { taskId: task.id, title: task.title, ...notice };
  if (testNotifier) {
    testNotifier(full);
    return;
  }
  try {
    const event = createNotificationEvent({
      provider: 'system',
      // action_required follows the owner's "needs action" preference; news always goes out when a channel is on.
      kind: notice.needsAction ? 'action_required' : 'info',
      code: 'agent.notification',
      // One tray entry per task: its newest news replaces the older one instead of piling up.
      meta: { message: full.message, sessionName: `📋 #${task.id} ${task.title}`, url: `/?task=${task.id}`, tag: `task:${task.id}` },
      severity: 'info',
      requiresUserAction: notice.needsAction,
    });
    for (const userId of recipients(task)) {
      // Per user: the dedupe window is global, so a shared key would reach only the first admin.
      // Set after creation: the JS factory's inferred type only allows its null default.
      notifyUserIfEnabled({ userId, event: { ...event, dedupeKey: `task:${userId}:${task.id}:${notice.kind}:${full.message.slice(0, 80)}` } });
    }
  } catch (error) {
    // A notification is a courtesy; it never breaks the task change that caused it.
    console.error('[Tasks] Could not notify the owner', { taskId: task.id, error: error instanceof Error ? error.message : String(error) });
  }
}

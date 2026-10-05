import { useEffect, useState } from 'react';

import type { BackgroundTask, ServerEvent } from '@/shared/types';

type UseBackgroundTasksArgs = {
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  sessionId: string | null;
};

/**
 * Tracks the work each session's CLI still runs in the background after its
 * turn completed — agents started with `run_in_background`, shells, monitors.
 *
 * The turn's `complete` clears the activity indicator while those agents keep
 * working, so this is the only signal that the session is not actually idle.
 * The server sends the full list on every change (`background_tasks`) and
 * repeats it in the `chat_subscribed` ack, so a late-opened tab catches up.
 *
 * Returns the viewed session's list, or `null` while the server has not said
 * anything about it yet (an older server, or before the subscribe ack) —
 * callers then fall back to their own guess instead of assuming "none".
 */
export function useBackgroundTasks({ subscribe, sessionId }: UseBackgroundTasksArgs): BackgroundTask[] | null {
  // Latest list per session, kept for every session the socket reports on so
  // switching back to one shows its agents at once instead of after the ack.
  const [tasksBySession, setTasksBySession] = useState<ReadonlyMap<string, BackgroundTask[]>>(() => new Map());

  useEffect(() => subscribe((event) => {
    if (event.kind !== 'background_tasks' && event.kind !== 'chat_subscribed') {
      return;
    }
    const eventSessionId = typeof event.sessionId === 'string' ? event.sessionId : '';
    // An ack from a server that predates this feature carries no list.
    if (!eventSessionId || !Array.isArray(event.backgroundTasks)) {
      return;
    }
    const tasks = event.backgroundTasks as BackgroundTask[];

    setTasksBySession((previous) => {
      const current = previous.get(eventSessionId);
      if (current && current.length === 0 && tasks.length === 0) {
        return previous;
      }
      const next = new Map(previous);
      next.set(eventSessionId, tasks);
      return next;
    });
  }), [subscribe]);

  return sessionId ? tasksBySession.get(sessionId) ?? null : null;
}

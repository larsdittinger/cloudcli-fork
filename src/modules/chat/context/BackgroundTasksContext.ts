import { createContext, useContext } from 'react';

import type { BackgroundTask } from '@/shared/types';

/**
 * Background work of the session shown in the chat, provided by ChatInterface
 * from useBackgroundTasks. `null` means the server has not reported on the
 * session yet, which is different from an empty list ("nothing runs").
 *
 * A context rather than props because the consumers sit far apart: the
 * composer's status tab, and every subagent card deep in the transcript.
 */
export const BackgroundTasksContext = createContext<BackgroundTask[] | null>(null);

/** The viewed session's background tasks, or `null` while they are unknown. */
export function useViewedBackgroundTasks(): BackgroundTask[] | null {
  return useContext(BackgroundTasksContext);
}

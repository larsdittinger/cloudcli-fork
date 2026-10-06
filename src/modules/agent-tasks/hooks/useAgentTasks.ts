import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { AgentTask, ServerEvent } from '@/shared/types';

/**
 * Agent tasks of one project (or every project when `projectPath` is null),
 * refetched whenever the server reports a task change.
 */
export function useAgentTasks(projectPath: string | null, includeOld: boolean) {
  const { subscribe } = useWebSocket();
  // The board's cards; replaced wholesale on every fetch.
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  // True only until the first fetch for the current scope answers.
  const [loading, setLoading] = useState(true);
  // Last fetch failure, shown above the board; cleared by the next success.
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const data = await readApiJson<{ data: AgentTask[] }>(await api.agentTasks.list(projectPath ?? undefined, includeOld));
      // A slower, older request must not overwrite a newer scope's data.
      if (request !== requestRef.current) return;
      setTasks(data.data);
      setError(null);
    } catch (err) {
      if (request === requestRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [projectPath, includeOld]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe((event: ServerEvent) => {
      if (event.kind !== 'tasks_updated' && event.kind !== 'channels_outbox_updated') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void load(); }, 250);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [subscribe, load]);

  return { tasks, loading, error, reload: load };
}

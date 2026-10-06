import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { AgentTaskDetail, ServerEvent } from '@/shared/types';

/** One task's card, diary and messages, kept live while its detail is open. */
export function useAgentTaskDetail(taskId: number | null) {
  const { subscribe } = useWebSocket();
  // The open task; null while loading or after it was deleted.
  const [detail, setDetail] = useState<AgentTaskDetail | null>(null);
  // Fetch failure (e.g. the task was deleted elsewhere).
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    if (taskId === null) return;
    const request = ++requestRef.current;
    try {
      const data = await readApiJson<{ data: AgentTaskDetail }>(await api.agentTasks.get(taskId));
      if (request !== requestRef.current) return;
      setDetail(data.data);
      setError(null);
    } catch (err) {
      if (request === requestRef.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, [taskId]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (taskId === null) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe((event: ServerEvent) => {
      // Outbox changes carry no task id; any of them may be this task's draft.
      const mine = event.kind === 'channels_outbox_updated'
        || (event.kind === 'tasks_updated' && (event.taskId === undefined || event.taskId === taskId));
      if (!mine) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void load(); }, 200);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [subscribe, load, taskId]);

  return { detail, error, reload: load };
}

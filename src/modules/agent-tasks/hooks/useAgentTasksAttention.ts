import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { ServerEvent } from '@/shared/types';

type Attention = { total: number; byProject: Record<string, number> };

const EMPTY: Attention = { total: 0, byProject: {} };

/** Open tasks that need the owner (a question, an unconfirmed mandate, a draft), kept current over the socket. */
export function useAgentTasksAttention(enabled = true): Attention {
  const { subscribe } = useWebSocket();
  // Latest counts from /api/tasks/summary; kept as the same object while unchanged.
  const [attention, setAttention] = useState<Attention>(EMPTY);

  const load = useCallback(async () => {
    try {
      const data = await readApiJson<{ data: Attention }>(await api.agentTasks.summary());
      const next = data.data ?? EMPTY;
      setAttention((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    } catch {
      // A badge is a hint; a failed request keeps the last count.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    void load();
    return subscribe((event: ServerEvent) => {
      if (event.kind === 'tasks_updated' || event.kind === 'channels_outbox_updated') void load();
    });
  }, [enabled, load, subscribe]);

  return enabled ? attention : EMPTY;
}

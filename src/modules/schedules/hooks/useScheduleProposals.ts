import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { ServerEvent } from '@/shared/types';

type ProposalSummary = { proposals: number; byProject: Record<string, number> };

const EMPTY: ProposalSummary = { proposals: 0, byProject: {} };

/** Agent proposals waiting for approval, kept current over the realtime socket. */
export function useScheduleProposals(enabled = true): ProposalSummary {
  const { subscribe } = useWebSocket();
  const [summary, setSummary] = useState<ProposalSummary>(EMPTY);

  const load = useCallback(async () => {
    try {
      const data = await readApiJson<{ data: ProposalSummary }>(await api.schedules.summary());
      const next = data.data ?? EMPTY;
      // Same numbers, same object: no re-render for every unrelated schedule change.
      setSummary((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    } catch {
      // A badge is a hint; a failed request just leaves the last count.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    void load();
    return subscribe((event: ServerEvent) => {
      if (event.kind === 'schedules_updated') void load();
    });
  }, [enabled, load, subscribe]);

  return enabled ? summary : EMPTY;
}

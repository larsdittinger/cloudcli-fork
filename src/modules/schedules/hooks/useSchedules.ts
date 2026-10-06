import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { Schedule, ScheduleRun, ServerEvent } from '@/shared/types';

const RUN_LIMIT = 100;

/**
 * Schedules and their run history for one project (or every project when
 * `projectPath` is null), refetched whenever the server reports a change.
 */
export function useSchedules(projectPath: string | null, runStatus: string) {
  const { subscribe } = useWebSocket();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const query = new URLSearchParams({ limit: String(RUN_LIMIT) });
      if (projectPath) query.set('projectPath', projectPath);
      if (runStatus) query.set('status', runStatus);
      const [scheduleData, runData] = await Promise.all([
        readApiJson<{ data: Schedule[] }>(await api.schedules.list(projectPath ?? undefined)),
        readApiJson<{ data: ScheduleRun[] }>(await api.schedules.runs(`?${query.toString()}`)),
      ]);
      // A slower, older request must not overwrite a newer scope's data.
      if (request !== requestRef.current) return;
      setSchedules(scheduleData.data);
      setRuns(runData.data);
      setError(null);
    } catch (err) {
      if (request === requestRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [projectPath, runStatus]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe((event: ServerEvent) => {
      if (event.kind !== 'schedules_updated') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void load(); }, 300);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [subscribe, load]);

  return { schedules, runs, loading, error, reload: load };
}

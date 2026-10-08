import { useEffect, useSyncExternalStore } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { ServerEvent } from '@/shared/types';

export type Attention = { total: number; byProject: Record<string, number> };

const EMPTY: Attention = { total: 0, byProject: {} };

/*
 * One count for the whole page: the sidebar rows, the header button and the
 * tab badge all read it, so /api/tasks/summary is fetched once, not per row.
 */
let current: Attention = EMPTY;
const listeners = new Set<() => void>();
let request = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

async function load() {
  const mine = ++request;
  try {
    const data = await readApiJson<{ data: Attention }>(await api.agentTasks.summary());
    // An older answer arriving late must not overwrite a newer count.
    if (mine !== request) return;
    const next = data.data ?? EMPTY;
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    current = next;
    listeners.forEach((listener) => listener());
  } catch {
    // A badge is a hint; a failed request keeps the last count.
  }
}

function scheduleLoad() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void load();
  }, 300);
}

function subscribeStore(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) void load();
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    // Nobody shows a badge any more: forget the count so the next viewer starts fresh.
    request++;
    if (timer) clearTimeout(timer);
    timer = null;
    current = EMPTY;
  };
}

const subscribeNothing = () => () => {};
const readCurrent = () => current;
const readEmpty = () => EMPTY;

/** Open tasks that need the owner (a question, an unconfirmed mandate, a draft), kept current over the socket. */
export function useAgentTasksAttention(enabled = true): Attention {
  const { subscribe } = useWebSocket();
  const attention = useSyncExternalStore(enabled ? subscribeStore : subscribeNothing, enabled ? readCurrent : readEmpty);

  useEffect(() => {
    if (!enabled) return undefined;
    // Every user of the hook listens, but the shared debounce makes it one fetch.
    return subscribe((event: ServerEvent) => {
      if (event.kind === 'tasks_updated' || event.kind === 'channels_outbox_updated') scheduleLoad();
    });
  }, [enabled, subscribe]);

  return attention;
}

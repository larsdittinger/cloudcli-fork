import { useEffect, useRef } from 'react';

import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { ServerEvent } from '@/shared/types';

type ChannelsEvent = ServerEvent & {
  kind: 'channels_inbox_updated' | 'channels_outbox_updated';
  messageId?: string;
  outboxId?: string;
  sessionId?: string | null;
  status?: string;
};

/**
 * Calls `onEvent` for every channels frame on the one chat socket, debounced so
 * a burst of status changes (queued → dispatched) triggers a single refetch.
 */
export function useChannelsEvents(onEvent: (event: ChannelsEvent) => void, debounceMs = 400): void {
  const { subscribe } = useWebSocket();
  const handlerRef = useRef(onEvent);

  useEffect(() => {
    handlerRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: ChannelsEvent | null = null;
    const unsubscribe = subscribe((event: ServerEvent) => {
      if (event.kind !== 'channels_inbox_updated' && event.kind !== 'channels_outbox_updated') return;
      pending = event as ChannelsEvent;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (pending) handlerRef.current(pending);
        pending = null;
      }, debounceMs);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [subscribe, debounceMs]);
}

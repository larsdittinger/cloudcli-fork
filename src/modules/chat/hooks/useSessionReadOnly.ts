import { useEffect, useState } from 'react';

import type { Project, ProjectSession, ServerEvent } from '@/shared/types';

type UseSessionReadOnlyArgs = {
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  sessionId: string | null;
  selectedSession: ProjectSession | null;
  selectedProject: Project | null;
};

/**
 * Whether the open chat is one the user may only watch: somebody else's chat
 * shared with a restricted user, or a new chat in a project they reach only
 * through shares (where they cannot start one). Their own older chats in such
 * a project stay writable, as the server allows.
 *
 * The sidebar row says so up front (`readOnly`, `sharedOnly`), and the server
 * confirms it in the `chat_subscribed` ack, which covers a chat opened by URL
 * before its row was loaded. The server refuses writes regardless; this only
 * keeps the UI from offering them.
 */
export function useSessionReadOnly({ subscribe, sessionId, selectedSession, selectedProject }: UseSessionReadOnlyArgs): boolean {
  const [readOnlySessionIds, setReadOnlySessionIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => subscribe((event) => {
    if (event.kind !== 'chat_subscribed' || event.readOnly !== true || typeof event.sessionId !== 'string') {
      return;
    }
    const ackedSessionId = event.sessionId;
    setReadOnlySessionIds((previous) => {
      if (previous.has(ackedSessionId)) {
        return previous;
      }
      const next = new Set(previous);
      next.add(ackedSessionId);
      return next;
    });
  }), [subscribe]);

  return (Boolean(selectedProject?.sharedOnly) && !selectedSession)
    || Boolean(selectedSession?.readOnly)
    || (sessionId !== null && readOnlySessionIds.has(sessionId));
}

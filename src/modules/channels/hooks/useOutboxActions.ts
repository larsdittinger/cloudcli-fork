import { useCallback, useState } from 'react';

import { api, readApiJson } from '@/shared/api';

/**
 * Send / discard / retry for outgoing drafts, used by the inbox lists and the
 * message detail; `after` reloads whatever shows them. The last failure is kept
 * so the card that caused it can show why.
 */
export function useOutboxActions(after: () => void | Promise<void>) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (id: string, action: () => Promise<Response>) => {
    setBusyId(id);
    setError(null);
    try {
      await readApiJson(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
      await after();
    }
  }, [after]);

  return {
    busyId,
    error,
    approve: (id: string, text: string, trustSender = false) => run(id, () => api.channels.approveOutbox(id, { text, trustSender })),
    discard: (id: string) => run(id, () => api.channels.discardOutbox(id)),
    retry: (id: string) => run(id, () => api.channels.retryOutbox(id)),
  };
}

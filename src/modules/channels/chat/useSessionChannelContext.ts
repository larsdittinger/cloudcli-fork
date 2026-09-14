import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useIsAdmin } from '@/shared/hooks/useIsAdmin';
import { useChannelsEvents } from '@/modules/channels/hooks/useChannelsEvents';
import type { ChannelMessage, ChannelRule, OutboxItem } from '@/modules/channels/types';

export type SessionChannelOrigin = { message: ChannelMessage; rule: ChannelRule | null };

/**
 * What a chat needs to know about the channel it came from: the inbound
 * message that started it and any replies waiting for approval.
 */
export function useSessionChannelContext(sessionId: string | null) {
  const isAdmin = useIsAdmin();
  const [origin, setOrigin] = useState<SessionChannelOrigin | null>(null);
  const [drafts, setDrafts] = useState<OutboxItem[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isAdmin || !sessionId) {
      setOrigin(null);
      setDrafts([]);
      return;
    }
    try {
      const [originData, outboxData] = await Promise.all([
        readApiJson<{ data: SessionChannelOrigin | null }>(await api.channels.messageBySession(sessionId)),
        readApiJson<{ data: OutboxItem[] }>(await api.channels.outbox(`?sessionId=${encodeURIComponent(sessionId)}&status=draft,failed,sending,sent`)),
      ]);
      setOrigin(originData.data);
      // Sent replies stay visible for a while so the user sees the confirmation; older ones drop off.
      const cutoff = Date.now() - 10 * 60 * 1000;
      setDrafts(outboxData.data.filter((item) => item.status !== 'sent' || new Date(item.sent_at ?? item.created_at).getTime() > cutoff));
    } catch {
      setOrigin(null);
      setDrafts([]);
    }
  }, [isAdmin, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useChannelsEvents((event) => {
    if (!sessionId) return;
    if (event.kind === 'channels_outbox_updated' && event.sessionId && event.sessionId !== sessionId) return;
    void refresh();
  });

  const run = useCallback(async (id: string, action: () => Promise<Response>) => {
    setBusyId(id);
    try {
      await readApiJson(await action());
    } finally {
      setBusyId(null);
      await refresh();
    }
  }, [refresh]);

  return {
    origin,
    drafts,
    busyId,
    approve: (id: string, text: string) => run(id, () => api.channels.approveOutbox(id, { text })),
    discard: (id: string) => run(id, () => api.channels.discardOutbox(id)),
    retry: (id: string) => run(id, () => api.channels.retryOutbox(id)),
    refresh,
  };
}

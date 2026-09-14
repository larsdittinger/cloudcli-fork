import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useIsAdmin } from '@/shared/hooks/useIsAdmin';
import { useChannelsEvents } from '@/modules/channels/hooks/useChannelsEvents';
import type { ChannelsSummary } from '@/modules/channels/types';

const EMPTY: ChannelsSummary = { unmatched: 0, queued: 0, failed: 0, drafts: 0, enabled: false };

/** Badge counts for the sidebar inbox button; refreshed on every channels frame. */
export function useChannelsSummary(): ChannelsSummary & { refresh: () => Promise<void> } {
  const isAdmin = useIsAdmin();
  const [summary, setSummary] = useState<ChannelsSummary>(EMPTY);

  const refresh = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const data = await readApiJson<{ data: ChannelsSummary }>(await api.channels.summary());
      setSummary(data.data);
    } catch {
      // Not fatal: the badge just stays where it was.
    }
  }, [isAdmin]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useChannelsEvents(() => { void refresh(); });

  return { ...summary, refresh };
}

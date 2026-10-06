import { useTranslation } from 'react-i18next';

import { useStaleBuildCheck } from '@/modules/stale-build/hooks/useStaleBuildCheck';
import { useWebSocket } from '@/shared/context/WebSocketContext';

/**
 * Mounted once by App inside the WebSocketProvider: a thin bar that asks a tab
 * running an outdated build to reload after a deploy, so open tabs do not keep
 * old code talking to a new server.
 */
export function StaleBuildBanner() {
  const { t } = useTranslation('common');
  const { subscribe } = useWebSocket();
  const { isStale } = useStaleBuildCheck({ subscribe });

  if (!isStale) return null;

  return (
    <div
      role="status"
      className="fixed left-1/2 top-2 z-[10001] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-card px-4 py-2 text-sm text-foreground shadow-lg"
    >
      <span>{t('staleBuild.message')}</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="shrink-0 rounded-md bg-primary px-3 py-1 font-medium text-primary-foreground hover:bg-primary/90"
      >
        {t('staleBuild.reload')}
      </button>
    </div>
  );
}

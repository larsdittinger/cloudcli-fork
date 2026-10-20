import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';

/** Red lock label in the chat header of an isolated project. */
export default function IsolationBadge({ className }: { className?: string }) {
  const { t } = useTranslation('isolation');
  return (
    <span
      title={t('badgeTitle')}
      className={cn(
        'inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-red-500/70 bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:border-red-400/70 dark:text-red-300',
        className,
      )}
    >
      <Lock className="h-3 w-3" aria-hidden />
      {t('badge')}
    </span>
  );
}

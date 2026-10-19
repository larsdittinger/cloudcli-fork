import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';

type Props = { count: number; className?: string };

/** Used by the agent-tasks badges: the amber count of tasks that need the owner (nothing when none). */
export default function AttentionCount({ count, className }: Props) {
  const { t } = useTranslation('agentTasks');
  if (count <= 0) return null;
  const label = t('badge', { count });
  return (
    <span
      aria-label={label}
      title={label}
      className={cn(
        'flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-none text-white',
        className,
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

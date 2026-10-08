import { cn } from '@/shared/utils';

type Props = { count: number; className?: string };

/** Used by the agent-tasks badges: the amber count of tasks that need the owner (nothing when none). */
export default function AttentionCount({ count, className }: Props) {
  if (count <= 0) return null;
  const label = `${count} task${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} you`;
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

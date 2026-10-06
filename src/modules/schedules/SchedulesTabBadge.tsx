import { useScheduleProposals } from '@/modules/schedules/hooks/useScheduleProposals';

/** Used by WorkspaceTabs on the Schedules tab: how many agent proposals wait for approval (nothing when none). */
export default function SchedulesTabBadge() {
  const { proposals } = useScheduleProposals();
  if (proposals === 0) return null;
  const label = `${proposals} schedule${proposals === 1 ? '' : 's'} waiting for approval`;
  return (
    <span
      aria-label={label}
      title={label}
      className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-none text-white"
    >
      {proposals}
    </span>
  );
}

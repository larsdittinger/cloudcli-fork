import { useAgentTasksAttention } from '@/modules/agent-tasks/hooks/useAgentTasksAttention';

/** Used by WorkspaceTabs on the Agent tasks tab: how many tasks need the owner (nothing when none). */
export default function AgentTasksTabBadge() {
  const { total } = useAgentTasksAttention();
  if (total === 0) return null;
  const label = `${total} task${total === 1 ? '' : 's'} need${total === 1 ? 's' : ''} you`;
  return (
    <span
      aria-label={label}
      title={label}
      className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-none text-white"
    >
      {total}
    </span>
  );
}

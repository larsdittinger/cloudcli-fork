import { useAgentTasksAttention } from '@/modules/agent-tasks/hooks/useAgentTasksAttention';
import AttentionCount from '@/modules/agent-tasks/AttentionCount';

type Props = { projectPath: string; className?: string };

/** Used by the sidebar in front of a project's name: its agent tasks that need the owner. */
export default function ProjectAttentionBadge({ projectPath, className }: Props) {
  const { byProject } = useAgentTasksAttention();
  return <AttentionCount count={byProject[projectPath] ?? 0} className={className} />;
}

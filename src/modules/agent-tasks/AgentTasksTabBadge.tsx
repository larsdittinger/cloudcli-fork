import { useAgentTasksAttention } from '@/modules/agent-tasks/hooks/useAgentTasksAttention';
import AttentionCount from '@/modules/agent-tasks/AttentionCount';

type Props = { projectPath: string };

/** Used by WorkspaceTabs on the Agent tasks tab: how many of this project's tasks need the owner. */
export default function AgentTasksTabBadge({ projectPath }: Props) {
  const { byProject } = useAgentTasksAttention();
  return <AttentionCount count={byProject[projectPath] ?? 0} />;
}

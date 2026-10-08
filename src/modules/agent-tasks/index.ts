// Agent tasks: the admin-only workspace tab for long-running agent tasks (board, detail, form).
export { default as AgentTasksPanel } from '@/modules/agent-tasks/AgentTasksPanel';
// AgentTasksTabBadge: used by the project workspace tabs to show how many of the project's tasks need the owner.
export { default as AgentTasksTabBadge } from '@/modules/agent-tasks/AgentTasksTabBadge';
// AllTasksButton: the sidebar header's entry to every project's tasks, with the total that needs the owner.
export { default as AllTasksButton } from '@/modules/agent-tasks/AllTasksButton';
// ProjectAttentionBadge: shown before a project's name in the sidebar when its tasks need the owner.
export { default as ProjectAttentionBadge } from '@/modules/agent-tasks/ProjectAttentionBadge';

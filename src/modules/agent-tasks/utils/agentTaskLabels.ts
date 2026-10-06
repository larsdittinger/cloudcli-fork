import type { AgentTask, AgentTaskInput, AgentTaskStatus } from '@/shared/types';

/** Board columns, left to right; `closed` holds done and cancelled tasks. */
export const BOARD_COLUMNS: Array<{ id: string; label: string; short: string; statuses: AgentTaskStatus[] }> = [
  { id: 'new', label: 'New', short: 'New', statuses: ['new'] },
  { id: 'working', label: 'Working', short: 'Working', statuses: ['working'] },
  { id: 'waiting_external', label: 'Waiting for a reply', short: 'Waiting', statuses: ['waiting_external'] },
  { id: 'waiting_owner', label: 'Needs you', short: 'For you', statuses: ['waiting_owner'] },
  { id: 'closed', label: 'Done', short: 'Done', statuses: ['done', 'cancelled'] },
];

/** What each status is called in menus and the diary. */
export const STATUS_LABELS: Record<AgentTaskStatus, string> = {
  new: 'New',
  working: 'Working',
  waiting_external: 'Waiting for a reply',
  waiting_owner: 'Needs you',
  done: 'Done',
  cancelled: 'Cancelled',
};

/** Last path segment, for showing which agent project runs a task. */
export function projectName(projectPath: string): string {
  return projectPath.split('/').filter(Boolean).pop() ?? projectPath;
}

/** Why a task needs the owner, most urgent first; empty when it does not. */
export function attentionReasons(task: AgentTask): string[] {
  if (task.status === 'done' || task.status === 'cancelled') return [];
  const reasons: string[] = [];
  if (task.question) reasons.push(task.question.by === 'system' ? 'Needs a decision' : 'Question for you');
  if (!task.mandateConfirmed) reasons.push('Confirm the mandate');
  if (task.draftCount > 0) reasons.push(task.draftCount === 1 ? '1 message to approve' : `${task.draftCount} messages to approve`);
  return reasons;
}

/** Returns the first problem with the form, or null when it can be saved. */
export function validateTaskForm(values: AgentTaskInput): string | null {
  if (!values.title.trim()) return 'Give the task a title.';
  if (!values.brief.trim()) return 'Describe what the agent should achieve.';
  if (!values.projectPath.trim().startsWith('/')) return 'The agent project must be an absolute path.';
  return null;
}

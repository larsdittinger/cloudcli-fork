import type { TFunction } from 'i18next';

import type { AgentTask, AgentTaskInput, AgentTaskStatus } from '@/shared/types';

/** Board columns, left to right; `closed` holds done and cancelled tasks. Labels are `columns.<id>.label|short` in agentTasks. */
export const BOARD_COLUMNS: Array<{ id: string; statuses: AgentTaskStatus[] }> = [
  { id: 'new', statuses: ['new'] },
  { id: 'working', statuses: ['working'] },
  { id: 'waiting_external', statuses: ['waiting_external'] },
  { id: 'waiting_owner', statuses: ['waiting_owner'] },
  { id: 'closed', statuses: ['done', 'cancelled'] },
];

/** Every status in menu order; each is called `status.<status>` in the agentTasks namespace. */
export const AGENT_TASK_STATUSES: AgentTaskStatus[] = ['new', 'working', 'waiting_external', 'waiting_owner', 'done', 'cancelled'];

/** Last path segment, for showing which agent project runs a task. */
export function projectName(projectPath: string): string {
  return projectPath.split('/').filter(Boolean).pop() ?? projectPath;
}

/** Why a task needs the owner, most urgent first; empty when it does not. `t` is bound to agentTasks. */
export function attentionReasons(task: AgentTask, t: TFunction): string[] {
  if (task.status === 'done' || task.status === 'cancelled') return [];
  const reasons: string[] = [];
  if (task.question) reasons.push(t(task.question.by === 'system' ? 'attention.decision' : 'attention.question'));
  if (!task.mandateConfirmed) reasons.push(t('attention.confirmMandate'));
  if (task.draftCount > 0) reasons.push(t('attention.drafts', { count: task.draftCount }));
  return reasons;
}

/** Returns the first problem with the form, or null when it can be saved. `t` is bound to agentTasks. */
export function validateTaskForm(values: AgentTaskInput, t: TFunction): string | null {
  if (!values.title.trim()) return t('validation.title');
  if (!values.brief.trim()) return t('validation.brief');
  if (!values.projectPath.trim().startsWith('/')) return t('validation.projectPath');
  return null;
}

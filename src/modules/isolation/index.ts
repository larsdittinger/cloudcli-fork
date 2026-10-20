// Isolation: lock marker, project menu, copy dialog and isolation settings of agents that run in the sandbox.
export { default as IsolationBadge } from '@/modules/isolation/IsolationBadge';
export { default as IsolationSettingsDialog } from '@/modules/isolation/IsolationSettingsDialog';
export { default as CopyProjectDialog } from '@/modules/isolation/CopyProjectDialog';
export { default as ProjectOptionsMenu } from '@/modules/isolation/ProjectOptionsMenu';
// Used by the settings module's Isolation tab: sandbox state and the Claude login of isolated agents.
export { useIsolationStatusResult } from '@/modules/isolation/hooks/useIsolation';
export { needsClaudeLogin, useClaudeLogin } from '@/modules/isolation/hooks/useClaudeLogin';
export type { ClaudeLoginState } from '@/modules/isolation/hooks/useClaudeLogin';

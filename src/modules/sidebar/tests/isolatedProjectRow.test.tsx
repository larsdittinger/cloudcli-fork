import assert from 'node:assert/strict';

import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

vi.mock('@/shared/hooks/useIsAdmin', () => ({ useIsAdmin: () => true }));
vi.mock('@/modules/agent-tasks', () => ({ ProjectAttentionBadge: () => null }));
vi.mock('@/modules/sidebar/SidebarProjectSessions', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({ useCompactSidebar: () => false }));

// The assertions read the English texts.
const { i18n } = await import('@/modules/i18n');
const { default: SidebarProjectItem } = await import('@/modules/sidebar/SidebarProjectItem');

afterEach(() => cleanup());

const project = (isolated: boolean): Project => ({
  projectId: isolated ? 'p-iso' : 'p-plain',
  displayName: isolated ? 'Support' : 'Plain',
  fullPath: isolated ? '/isolated/support' : '/workspace/plain',
  isolated,
  sessionMeta: { total: 0, hasMore: false },
}) as unknown as Project;

const rowProps = (p: Project) => ({
  project: p, selectedProject: null, selectedSession: null, isExpanded: false, isDeleting: false, isStarred: false,
  isEditing: false, renameDraft: '', sessions: [], initialSessionsLoaded: true, isLoadingMoreSessions: false,
  currentTime: new Date(), sessionRenameId: null, sessionRenameDraft: '', tasksEnabled: false,
  mcpServerStatus: { hasMCPServer: false, isConfigured: false } as never,
  onRenameDraftChange: () => {}, onToggleProject: () => {}, onProjectSelect: () => {}, onToggleStarProject: () => {},
  onStartEditingProject: () => {}, onCancelEditingProject: () => {}, onSaveProjectName: () => {}, onDeleteProject: () => {},
  onSessionSelect: () => {}, onDeleteSession: () => {}, onLoadMoreSessions: () => {},
  activeSessions: new Set<string>(), backgroundSessionIds: new Set<string>(), attentionSessionIds: new Set<string>(),
  onNewSession: () => {}, onStartEditingSession: () => {}, onCancelEditingSession: () => {}, onSaveEditingSession: () => {},
  selectedSessionIds: null, onSetSessionSelection: () => {}, onToggleSessionSelected: () => {}, onCancelSessionSelection: () => {},
  onDeleteSelectedSessions: () => {}, t: ((key: string, options?: Record<string, unknown>) => i18n.t(key, options)) as never,
});

test('renders lock and red border for isolated project', () => {
  const { container } = render(<SidebarProjectItem {...rowProps(project(true))} />);
  const row = container.querySelector('[data-isolated="true"]');
  assert.ok(row, 'the row is marked');
  assert.match(row!.className, /border-red-500\/70/);
  assert.match(row!.className, /dark:border-red-400\/70/);
  assert.ok(row!.querySelector('svg.lucide-lock'), 'lock icon');
  assert.match(row!.getAttribute('title') ?? '', /Isolated agent/);
});

test('no lock for normal project', () => {
  const { container } = render(<SidebarProjectItem {...rowProps(project(false))} />);
  assert.equal(container.querySelector('[data-isolated="true"]'), null);
  assert.equal(container.querySelector('svg.lucide-lock'), null);
});


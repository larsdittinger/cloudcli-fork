import assert from 'node:assert/strict';

import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

vi.mock('@/modules/plugins', () => ({ usePlugins: () => ({ plugins: [] }) }));

await import('@/modules/i18n');
const { default: WorkspaceTitle } = await import('@/modules/project-workspace/WorkspaceTitle');

afterEach(() => cleanup());

const project = (isolated: boolean): Project => ({
  projectId: isolated ? 'p-iso' : 'p-plain',
  displayName: isolated ? 'Support' : 'Plain',
  fullPath: isolated ? '/isolated/support' : '/workspace/plain',
  isolated,
  sessionMeta: { total: 0, hasMore: false },
}) as unknown as Project;

test('workspace title carries the isolation badge only for isolated projects', () => {
  const props = { activeTab: 'chat' as const, selectedSession: null, shouldShowTasksTab: false, onRenameSession: async () => true };
  const { unmount } = render(<WorkspaceTitle {...props} selectedProject={project(true)} />);
  assert.ok(screen.getByText('Isolated'));
  unmount();
  render(<WorkspaceTitle {...props} selectedProject={project(false)} />);
  assert.equal(screen.queryByText('Isolated'), null);
});

import assert from 'node:assert/strict';

import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, test } from 'vitest';

await import('@/modules/i18n');
const { default: GitPanelHeader } = await import('@/modules/git-panel/GitPanelHeader');

afterEach(() => cleanup());

test('git header of an isolated project has no remote actions and explains why', async () => {
  const noop = () => {};
  const common = {
    isMobile: false, currentBranch: 'main', branches: ['main'], isLoading: false, isCreatingBranch: false,
    isFetching: false, isPulling: false, isPushing: false, isPublishing: false, isRevertingLocalCommit: false,
    operationError: null, onRefresh: noop, onRevertLocalCommit: async () => {}, onSwitchBranch: async () => true,
    onCreateBranch: async () => true, onFetch: async () => {}, onPull: async () => {}, onPush: async () => {},
    onPublish: async () => {}, onClearError: noop, onRequestConfirmation: noop,
    remoteStatus: { hasRemote: true, hasUpstream: true, ahead: 1, behind: 1, remoteName: 'origin', isUpToDate: false } as never,
  };
  const { unmount } = render(<GitPanelHeader {...common} remoteDisabled />);
  const explain = screen.getByTitle(/not available for isolated projects/);
  assert.equal((explain as HTMLButtonElement).disabled, true);
  assert.equal(screen.getAllByTitle(/not available for isolated projects/).length, 1);
  assert.equal(screen.queryAllByTitle(/^Pull|^Push|^Fetch|^Publish/).length, 0, 'no remote action buttons');
  unmount();
  render(<GitPanelHeader {...common} />);
  assert.ok(screen.getAllByTitle(/^(Pull|Push|Fetch)/i).length > 0, 'a normal project keeps its remote actions');
  assert.equal(screen.queryAllByTitle(/not available for isolated projects/).length, 0);
});


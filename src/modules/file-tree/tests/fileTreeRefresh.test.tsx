import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { FileTreeNode, Project } from '@/shared/types';

/**
 * A refresh (after an upload, rename, create or delete) must not swap the tree
 * for the loading placeholder: that unmounts every row, so the scroll position,
 * an open context menu and a rename in progress all disappear — it looks like
 * the UI resets itself while an upload is running.
 */

type PendingFetch = { projectId: string; resolve: (files: FileTreeNode[]) => void };
const pending: PendingFetch[] = [];

vi.mock('@/shared/api', () => ({
  api: {
    getFiles: (projectId: string) => new Promise((resolve) => {
      pending.push({
        projectId,
        resolve: (files) => resolve({ ok: true, json: async () => files }),
      });
    }),
  },
}));

const project = (projectId: string) => ({ projectId, name: projectId, path: `/workspace/${projectId}` }) as unknown as Project;
const tree = (name: string): FileTreeNode[] => [{ name, path: name, type: 'file' } as FileTreeNode];

beforeEach(() => {
  pending.length = 0;
});

test('a refresh keeps the current tree on screen until the new one arrives', async () => {
  const { useFileTreeData } = await import('@/modules/file-tree/hooks/useFileTreeData');
  const { result } = renderHook(() => useFileTreeData(project('a')));

  assert.equal(result.current.loading, true);
  await act(async () => pending.shift()!.resolve(tree('first.txt')));
  await waitFor(() => assert.equal(result.current.loading, false));

  act(() => result.current.refreshFiles());

  assert.equal(result.current.loading, false);
  assert.equal(result.current.refreshing, true);
  assert.deepEqual(result.current.files.map((file) => file.name), ['first.txt']);

  await act(async () => pending.shift()!.resolve(tree('second.txt')));
  await waitFor(() => assert.equal(result.current.refreshing, false));
  assert.deepEqual(result.current.files.map((file) => file.name), ['second.txt']);
});

test('switching projects clears the old tree and shows the loading state', async () => {
  const { useFileTreeData } = await import('@/modules/file-tree/hooks/useFileTreeData');
  const { result, rerender } = renderHook(({ selected }) => useFileTreeData(selected), {
    initialProps: { selected: project('a') },
  });
  await act(async () => pending.shift()!.resolve(tree('a.txt')));
  await waitFor(() => assert.equal(result.current.loading, false));

  rerender({ selected: project('b') });

  assert.equal(result.current.loading, true);
  assert.deepEqual(result.current.files, []);
  await act(async () => pending.shift()!.resolve(tree('b.txt')));
  await waitFor(() => assert.deepEqual(result.current.files.map((file) => file.name), ['b.txt']));
});

import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

const writeDraftText = vi.fn();
vi.mock('@/shared/chatDrafts', () => ({ writeDraftText: (...args: unknown[]) => writeDraftText(...args) }));

const { readPromptLink, usePromptLink } = await import('@/modules/project-workspace/hooks/usePromptLink');

const project = { projectId: 'p1', displayName: 'Shop', fullPath: '/workspace/shop' } as Project;

afterEach(() => {
  writeDraftText.mockReset();
  window.history.replaceState(null, '', '/');
});

test('readPromptLink: session link, project link, nothing to do', () => {
  assert.deepEqual(readPromptLink('?prompt=Ahoj', 's1'), { prompt: 'Ahoj', scope: 'session', target: 's1' });
  assert.deepEqual(readPromptLink('?project=%2Fworkspace%2Fshop&prompt=Shr%C5%88'), { prompt: 'Shrň', scope: 'project', target: '/workspace/shop' });
  assert.equal(readPromptLink('?project=/x'), null);
  assert.equal(readPromptLink('?prompt=Ahoj'), null, 'a prompt without a target is ignored');
});

test('usePromptLink: a session link fills that chat draft and drops the query', () => {
  window.history.replaceState(null, '', '/session/s1?prompt=Pod%C3%ADvej%20se');
  const navigate = vi.fn();
  renderHook(() => usePromptLink({ sessionId: 's1', projects: [], isLoadingProjects: true, navigate, startNewSession: vi.fn() }));
  assert.deepEqual(writeDraftText.mock.calls, [['s1', 'Podívej se']]);
  assert.deepEqual(navigate.mock.calls, [['/session/s1', { replace: true }]]);
});

test('usePromptLink: a project link waits for projects, then opens a new chat with the draft', () => {
  window.history.replaceState(null, '', '/?project=%2Fworkspace%2Fshop&prompt=Nov%C3%BD');
  const navigate = vi.fn();
  const startNewSession = vi.fn();
  const { rerender } = renderHook((props: { loading: boolean }) => usePromptLink({
    projects: props.loading ? [] : [project], isLoadingProjects: props.loading, navigate, startNewSession,
  }), { initialProps: { loading: true } });
  assert.equal(writeDraftText.mock.calls.length, 0);

  rerender({ loading: false });
  assert.deepEqual(startNewSession.mock.calls, [[project]]);
  assert.deepEqual(writeDraftText.mock.calls, [['project:p1', 'Nový']]);
});

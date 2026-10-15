import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useSessionReadOnly } from '@/modules/chat/hooks/useSessionReadOnly';
import type { Project, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * A chat shared with a restricted user is watched, not written. The sidebar row
 * says so up front, and the server's subscribe ack says so for a chat opened by
 * URL before its row was loaded.
 */

const PROJECT: Project = { projectId: 'p1', displayName: 'Marketing', fullPath: '/workspace/marketing' };

function createBus() {
  const listeners = new Set<(event: ServerEvent) => void>();
  return {
    subscribe: (listener: (event: ServerEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event: ServerEvent) => listeners.forEach((listener) => listener(event)),
  };
}

const renderReadOnly = (
  bus: ReturnType<typeof createBus>,
  session: ProjectSession | null,
  project: Project = PROJECT,
) => renderHook(() => useSessionReadOnly({
  subscribe: bus.subscribe,
  sessionId: session?.id ?? null,
  selectedSession: session,
  selectedProject: project,
}));

test('an own chat is writable, a row marked readOnly is not', () => {
  const bus = createBus();
  assert.equal(renderReadOnly(bus, { id: 'mine' }).result.current, false);
  assert.equal(renderReadOnly(bus, { id: 'theirs', readOnly: true }).result.current, true);
});

test('a project reached only through shares offers no new chat, but keeps own chats writable', () => {
  const bus = createBus();
  const sharedOnly = { ...PROJECT, sharedOnly: true };
  assert.equal(renderReadOnly(bus, null, sharedOnly).result.current, true);
  assert.equal(renderReadOnly(bus, { id: 'mine-from-before' }, sharedOnly).result.current, false);
  assert.equal(renderReadOnly(bus, { id: 'shared', readOnly: true }, sharedOnly).result.current, true);
});

test('the subscribe ack marks a chat read-only, and only that chat', () => {
  const bus = createBus();
  const opened = renderReadOnly(bus, { id: 'by-url' });
  assert.equal(opened.result.current, false);

  act(() => {
    bus.emit({ kind: 'chat_subscribed', sessionId: 'other', readOnly: true });
  });
  assert.equal(opened.result.current, false);

  act(() => {
    bus.emit({ kind: 'chat_subscribed', sessionId: 'by-url', readOnly: true });
  });
  assert.equal(opened.result.current, true);
});

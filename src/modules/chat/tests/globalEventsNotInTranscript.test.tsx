import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import { removeOptimisticUserEchoes } from '@/modules/chat/utils/sessionMessageReconciliation';
import type { NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * App-wide broadcasts (Tasks, Schedules, Channels) carry no chat content. Before
 * this fix one landed in whatever chat was open as a transcript row without an
 * `id`, and the next send in that chat crashed while merging rows — the message
 * never left the composer ("I can't write into this chat").
 */

const renderHandlers = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const appended: Array<{ sid: string; message: unknown }> = [];

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: 'viewed-session' } as ProjectSession,
    currentSessionId: 'viewed-session',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async () => {},
    sessionStore: { appendRealtime: (sid: string, message: unknown) => { appended.push({ sid, message }); } } as unknown as SessionStore,
  }));

  return { dispatch: (event: ServerEvent) => listener?.(event), appended };
};

test('app-wide broadcasts never become rows of the open chat', () => {
  const { dispatch, appended } = renderHandlers();
  for (const event of [
    { kind: 'tasks_updated', taskId: 3, timestamp: '2026-10-06T19:18:00Z' },
    { kind: 'schedules_updated', scheduleId: 'x', timestamp: '2026-10-06T19:18:00Z' },
    { kind: 'channels_inbox_updated', messageId: 'm', status: 'task' },
    // Outbox updates name the chat that wrote the message — still not a transcript row.
    { kind: 'channels_outbox_updated', outboxId: 'o', sessionId: 'viewed-session', status: 'draft' },
    { kind: 'channels_proposals_updated', proposalId: 'p' },
  ]) {
    dispatch(event as unknown as ServerEvent);
  }
  assert.deepEqual(appended, []);
});

test('provider messages of the open chat are still stored', () => {
  const { dispatch, appended } = renderHandlers();
  dispatch({ kind: 'text', id: 'm1', role: 'assistant', content: 'OK', sessionId: 'viewed-session', seq: 1 } as unknown as ServerEvent);
  assert.equal(appended.length, 1);
});

test('a row without an id cannot break merging the transcript', () => {
  const realtime = [
    { kind: 'tasks_updated', timestamp: '2026-10-06T19:18:00Z' },
    { id: 'local_1', kind: 'text', role: 'user', content: 'ahoj', timestamp: '2026-10-06T19:18:01Z' },
  ] as unknown as NormalizedMessage[];
  assert.doesNotThrow(() => removeOptimisticUserEchoes([], realtime));
});

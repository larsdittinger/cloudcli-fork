import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage } from '@/shared/types';

/**
 * Merging the transcript matches rows by `id`. One row without it made every
 * later append throw, so the user's next message never left the composer.
 * The store is the last place that can guarantee the invariant for every
 * caller, so it gives such a row an id instead of trusting the sender.
 */

test('a row without an id gets one and does not break the next append', () => {
  const { result } = renderHook(() => useSessionStore());

  act(() => {
    result.current.appendRealtime('s1', {
      kind: 'text', role: 'assistant', content: 'no id', sessionId: 's1', timestamp: '2026-10-06T19:56:00Z',
    } as unknown as NormalizedMessage);
  });

  assert.doesNotThrow(() => {
    act(() => {
      result.current.appendRealtime('s1', {
        id: 'local_1', kind: 'text', role: 'user', content: 'reply', sessionId: 's1',
        provider: 'claude', timestamp: '2026-10-06T19:57:00Z',
      } as NormalizedMessage);
    });
  });

  const messages = result.current.getMessages('s1');
  assert.deepEqual(messages.map((message) => message.content), ['no id', 'reply']);
  assert.ok(messages.every((message) => typeof message.id === 'string' && message.id.length > 0));
});

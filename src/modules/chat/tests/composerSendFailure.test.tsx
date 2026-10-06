import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { PermissionMode, Project } from '@/shared/types';

/**
 * "I click Send and nothing happens": a send that threw inside the composer
 * was an unhandled promise rejection — no request, no error, the text just sat
 * there. A send into a closed socket was worse: the text vanished and nothing
 * reached the server. Either way the user must keep the text and see why.
 */

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      providers: { createSession: () => okJson({ data: { sessionId: 'new-session' } }) },
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      files: { search: () => okJson({ success: true, files: [] }) },
    },
  };
});

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };

const renderComposer = (overrides: {
  addMessage?: () => void;
  sendMessage?: (message: unknown) => boolean | void;
  resolvePermissionModeForProvider?: () => PermissionMode;
}) => renderHook(() => useChatComposerState({
  selectedProject: PROJECT,
  selectedSession: { id: 'session-a' },
  currentSessionId: 'session-a',
  provider: 'claude',
  permissionMode: 'default',
  cyclePermissionMode: () => undefined,
  resolvePermissionModeForProvider: overrides.resolvePermissionModeForProvider ?? (() => 'default' as PermissionMode),
  currentProviderModel: 'test-model',
  currentProviderEffort: 'medium',
  isLoading: false,
  canAbortSession: false,
  tokenBudget: null,
  sendMessage: overrides.sendMessage ?? (() => true),
  scrollToBottom: () => undefined,
  addMessage: overrides.addMessage ?? (() => undefined),
  setIsUserScrolledUp: () => undefined,
  setPendingPermissionRequests: () => undefined,
}));

const submit = async (view: ReturnType<typeof renderComposer>) => {
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
};

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

test('a send that throws before it leaves keeps the text and says why', async () => {
  const sendMessage = vi.fn(() => true);
  const view = renderComposer({
    sendMessage,
    resolvePermissionModeForProvider: () => { throw new TypeError("Cannot read properties of undefined (reading 'startsWith')"); },
  });
  await act(async () => { view.result.current.setInput('na vodni bazi?'); });

  await submit(view);

  assert.equal(view.result.current.input, 'na vodni bazi?');
  assert.equal(view.result.current.sendError?.reason, 'failed');
  assert.match(view.result.current.sendError?.detail ?? '', /startsWith/);
  assert.equal(sendMessage.mock.calls.length, 0);
});

test('a crash after the message left is reported, and a retry cannot send it twice', async () => {
  const sendMessage = vi.fn(() => true);
  const view = renderComposer({ sendMessage, addMessage: () => { throw new Error('merge failed'); } });
  await act(async () => { view.result.current.setInput('ahoj'); });

  await submit(view);

  assert.equal(sendMessage.mock.calls.length, 1);
  assert.equal(view.result.current.input, '');
  assert.match(view.result.current.sendError?.detail ?? '', /merge failed/);
});

test('a send into a closed socket keeps the text and says it failed', async () => {
  const addMessage = vi.fn();
  const view = renderComposer({ sendMessage: () => false, addMessage });
  await act(async () => { view.result.current.setInput('ahoj'); });

  await submit(view);

  assert.equal(view.result.current.input, 'ahoj');
  assert.equal(view.result.current.sendError?.reason, 'offline');
  assert.equal(addMessage.mock.calls.length, 0, 'no echo of a message that never left');
});

test('a successful send clears the text and any previous error', async () => {
  const sendMessage = vi.fn((_message: unknown) => true);
  let fail = true;
  const view = renderComposer({ sendMessage: (message) => (fail ? false : sendMessage(message)) });
  await act(async () => { view.result.current.setInput('ahoj'); });
  await submit(view);
  assert.ok(view.result.current.sendError);

  fail = false;
  await submit(view);

  assert.equal(view.result.current.input, '');
  assert.equal(view.result.current.sendError, null);
  assert.equal(sendMessage.mock.calls.length, 1);
});

test('a new chat that cannot be sent keeps the text in the chat it just opened', async () => {
  // The chat is created over HTTP and opened before the socket send fails, so
  // the composer switches to the new chat's draft — that is where the text must be.
  const view = renderHook(
    ({ sessionId }: { sessionId: string | null }) => useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: sessionId ? { id: sessionId } : null,
      currentSessionId: sessionId,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: () => false,
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
    { initialProps: { sessionId: null as string | null } },
  );
  await act(async () => { view.result.current.setInput('first message'); });

  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
  // The parent navigates to the new chat after onSessionEstablished.
  await act(async () => { view.rerender({ sessionId: 'new-session' }); });

  assert.equal(view.result.current.input, 'first message');
  assert.equal(view.result.current.sendError?.reason, 'offline');
});

test('the error of one chat is not shown in another', async () => {
  const view = renderHook(
    ({ sessionId }: { sessionId: string }) => useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: { id: sessionId },
      currentSessionId: sessionId,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: () => false,
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
    { initialProps: { sessionId: 'session-a' } },
  );
  await act(async () => { view.result.current.setInput('ahoj'); });
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
  assert.ok(view.result.current.sendError);

  await act(async () => { view.rerender({ sessionId: 'session-b' }); });
  assert.equal(view.result.current.sendError, null);

  await act(async () => { view.rerender({ sessionId: 'session-a' }); });
  assert.ok(view.result.current.sendError, 'back in the chat it belongs to');
});

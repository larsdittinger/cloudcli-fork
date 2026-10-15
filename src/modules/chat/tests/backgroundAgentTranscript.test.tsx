import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

// The assertions read the English labels.
import '@/modules/i18n';
import BackgroundTasksTab from '@/modules/chat/composer/BackgroundTasksTab';
import { TranscriptSessionContext } from '@/modules/chat/context/TranscriptSessionContext';
import type { BackgroundTask } from '@/shared/types';

/**
 * A background agent streams nothing of its own work to the chat, so the
 * composer's list is the only place to tell a working agent from a stuck one:
 * spent tokens, time since its last step, and its transcript on a click.
 */

const subagentActivity = vi.fn();

// Only the endpoint is stubbed; `readApiJson` stays real so the dialog parses
// the same envelope the server sends.
vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: { subagentActivity: (...args: unknown[]) => subagentActivity(...args) },
}));

const agentTask = (overrides: Partial<BackgroundTask> = {}): BackgroundTask => ({
  taskId: 'a6d28bc06febf1598',
  taskType: 'local_agent',
  description: 'PPL labels: analysis',
  toolUseId: 'toolu_1',
  subagentType: 'web',
  startedAt: Date.now() - 65_000,
  activity: 'Running Check boot timing',
  toolUses: 47,
  totalTokens: 84_512,
  lastActivityAt: Date.now() - 4_000,
  ...overrides,
});

const renderTab = (tasks: BackgroundTask[]) => render(
  <TranscriptSessionContext.Provider value={{ sessionId: 'session-1' }}>
    <BackgroundTasksTab tasks={tasks} />
  </TranscriptSessionContext.Provider>,
);

test('the tab and each row show the tokens spent and when the agent last moved', () => {
  renderTab([agentTask(), agentTask({ taskId: 'a1e064cf8bd159d60', totalTokens: 10_000, lastActivityAt: Date.now() - 6 * 60_000 })]);

  const tab = screen.getByRole('button', { expanded: false });
  assert.match(tab.textContent ?? '', /95k tokens/);

  fireEvent.click(tab);
  assert.ok(screen.getByText(/Running Check boot timing · 47 tools · 85k tokens · web/));
  assert.ok(screen.getByText(/Last step 4s ago/));
  // Quiet for longer than a tool call usually takes: worth a look.
  assert.ok(screen.getByText(/No progress for 6m/));
});

test('clicking an agent opens its transcript read from the server', async () => {
  subagentActivity.mockResolvedValue(new Response(JSON.stringify({
    success: true,
    data: {
      agent: { id: 'a6d28bc06febf1598', label: 'PPL labels: analysis', model: 'claude-opus-4-1', status: 'running' },
      activity: [{ kind: 'text', content: 'Reading the label plugin.' }],
      activityCount: 1,
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

  renderTab([agentTask()]);
  fireEvent.click(screen.getByRole('button', { expanded: false }));
  fireEvent.click(screen.getByTitle('Show what the agent is doing'));

  await waitFor(() => assert.ok(screen.getByText('Reading the label plugin.')));
  assert.deepEqual(subagentActivity.mock.calls[0], ['session-1', 'a6d28bc06febf1598']);
  assert.ok(screen.getByRole('heading', { name: /PPL labels: analysis/ }));
});

test('a shell in the background has no transcript to open', () => {
  renderTab([agentTask({ taskId: 'b1', taskType: 'local_bash' })]);
  fireEvent.click(screen.getByRole('button', { expanded: false }));
  assert.equal(screen.queryByTitle('Show what the agent is doing'), null);
});

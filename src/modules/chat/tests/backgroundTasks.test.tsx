import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { test } from 'vitest';

import BackgroundTasksTab from '@/modules/chat/composer/BackgroundTasksTab';
import { BackgroundTasksContext } from '@/modules/chat/context/BackgroundTasksContext';
import { useBackgroundTasks } from '@/modules/chat/hooks/useBackgroundTasks';
import { SubagentPanel } from '@/modules/chat/tools/SubagentPanel';
import type { BackgroundTask, ServerEvent, SubagentInfo } from '@/shared/types';

/**
 * A background agent's launch result arrives at once, so the transcript alone
 * shows it "done" while it keeps working after the turn. The server's live
 * task list decides instead, and the composer gets a tab for that work.
 */

const agentTask = (overrides: Partial<BackgroundTask> = {}): BackgroundTask => ({
  taskId: 'agent-1',
  taskType: 'local_agent',
  description: 'count to three',
  toolUseId: 'toolu_1',
  subagentType: 'general-purpose',
  startedAt: Date.now() - 65_000,
  activity: 'Running Sleep for 20 seconds',
  toolUses: 2,
  ...overrides,
});

const launchResult = { content: '', isError: false };

const renderPanel = (tasks: BackgroundTask[] | null, subagent?: SubagentInfo) => render(
  <BackgroundTasksContext.Provider value={tasks}>
    <SubagentPanel
      toolInput={{ description: 'count to three', prompt: 'sleep' }}
      toolId="toolu_1"
      toolResult={launchResult}
      subagent={subagent}
      createDiff={() => []}
    />
  </BackgroundTasksContext.Provider>,
);

test('an agent listed as a background task shows running despite its launch result', () => {
  renderPanel([agentTask()]);
  assert.ok(screen.getByText('running'));
});

test('without a known task list the panel keeps its own guess', () => {
  renderPanel(null);
  assert.equal(screen.queryByText('running'), null);
});

test('a transcript guess of "running" yields once the live list no longer has the agent', () => {
  renderPanel([], { id: 'agent-1', status: 'running' });
  assert.equal(screen.queryByText('running'), null);
});

test('the agent id matches when the start event (and so the tool id) was missed', () => {
  renderPanel([agentTask({ toolUseId: null })], { id: 'agent-1', status: 'completed' });
  assert.ok(screen.getByText('running'));
});

test('the tab counts agents and unfolds what each one does', () => {
  render(<BackgroundTasksTab tasks={[agentTask(), agentTask({ taskId: 'agent-2', toolUseId: 'toolu_2', description: 'lint' })]} />);

  const tab = screen.getByRole('button');
  assert.match(tab.textContent ?? '', /2 agents/);
  assert.match(tab.textContent ?? '', /1m 5s/);

  fireEvent.click(tab);
  assert.equal(screen.getAllByRole('listitem').length, 2);
  assert.ok(screen.getByText('lint'));
  assert.ok(screen.getAllByText(/Running Sleep for 20 seconds · 2 tools · general-purpose/).length > 0);
});

test('a mix of agents and shells is counted as tasks', () => {
  render(<BackgroundTasksTab tasks={[agentTask(), agentTask({ taskId: 'b1', taskType: 'local_bash' })]} />);
  assert.match(screen.getByRole('button').textContent ?? '', /2 tasks/);
});

test('useBackgroundTasks follows snapshots and subscribe acks per session', () => {
  let emit: (event: ServerEvent) => void = () => {};
  const subscribe = (listener: (event: ServerEvent) => void) => {
    emit = listener;
    return () => {};
  };

  const { result, rerender } = renderHook(
    ({ sessionId }) => useBackgroundTasks({ subscribe, sessionId }),
    { initialProps: { sessionId: 'viewed' as string | null } },
  );
  assert.equal(result.current, null);

  // An ack from an older server says nothing about background work.
  act(() => emit({ kind: 'chat_subscribed', sessionId: 'viewed', isProcessing: false }));
  assert.equal(result.current, null);

  act(() => emit({ kind: 'chat_subscribed', sessionId: 'viewed', backgroundTasks: [agentTask()] }));
  assert.equal(result.current?.length, 1);

  act(() => emit({ kind: 'background_tasks', sessionId: 'other', backgroundTasks: [agentTask(), agentTask()] }));
  assert.equal(result.current?.length, 1);

  act(() => emit({ kind: 'background_tasks', sessionId: 'viewed', backgroundTasks: [] }));
  assert.deepEqual(result.current, []);

  rerender({ sessionId: 'other' });
  assert.equal(result.current?.length, 2);
});

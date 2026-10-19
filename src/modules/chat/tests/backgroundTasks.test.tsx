import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { test } from 'vitest';

// The assertions read the English labels.
import '@/modules/i18n';
import BackgroundTasksTab from '@/modules/chat/composer/BackgroundTasksTab';
import { BackgroundTasksContext } from '@/modules/chat/context/BackgroundTasksContext';
import { useBackgroundTasks } from '@/modules/chat/hooks/useBackgroundTasks';
import { SubagentPanel } from '@/modules/chat/tools/SubagentPanel';
import { activityBesideBackgroundTasks } from '@/modules/chat/utils/backgroundTasks';
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

test('each listed task can be stopped on its own, which the upstream strip used to offer', () => {
  const stopped: string[] = [];
  render(
    <BackgroundTasksTab
      tasks={[agentTask(), agentTask({ taskId: 'b1', taskType: 'local_bash', description: 'npm test' })]}
      onStopTask={(taskId) => stopped.push(taskId)}
    />,
  );
  fireEvent.click(screen.getByRole('button', { expanded: false }));

  const stops = screen.getAllByRole('button', { name: 'Stop' });
  assert.equal(stops.length, 2);
  fireEvent.click(stops[1]);
  assert.deepEqual(stopped, ['b1']);
  // Stopping is its own button, not a click through to the agent's transcript.
  assert.equal(screen.queryByRole('dialog'), null);
});

test('a viewer without a stop handler gets no Stop', () => {
  render(<BackgroundTasksTab tasks={[agentTask()]} />);
  fireEvent.click(screen.getByRole('button', { expanded: false }));
  assert.equal(screen.queryByRole('button', { name: 'Stop' }), null);
});

test('the upstream "Background work" tab steps aside for this tab, a running turn does not', () => {
  const background = { statusText: null, canInterrupt: false, startedAt: 1, background: true };
  const responding = { statusText: null, canInterrupt: true, startedAt: 1 };

  assert.equal(activityBesideBackgroundTasks(background, [agentTask()]), null);
  assert.equal(activityBesideBackgroundTasks(responding, [agentTask()]), responding);
  // Other providers send no task list; their background work keeps upstream's tab.
  assert.equal(activityBesideBackgroundTasks(background, []), background);
  assert.equal(activityBesideBackgroundTasks(null, [agentTask()]), null);
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
  assert.equal((result.current as unknown[] | null)?.length, 1);

  act(() => emit({ kind: 'background_tasks', sessionId: 'other', backgroundTasks: [agentTask(), agentTask()] }));
  assert.equal((result.current as unknown[] | null)?.length, 1);

  act(() => emit({ kind: 'background_tasks', sessionId: 'viewed', backgroundTasks: [] }));
  assert.deepEqual(result.current, []);

  rerender({ sessionId: 'other' });
  assert.equal((result.current as unknown[] | null)?.length, 2);
});

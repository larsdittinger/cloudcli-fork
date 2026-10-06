import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { AgentTask, AgentTaskDetail } from '@/shared/types';

const calls: Array<{ name: string; args: unknown[] }> = [];
let listData: AgentTask[] = [];
let detailData: AgentTaskDetail | null = null;
let summaryData = { total: 0, byProject: {} as Record<string, number> };

function ok(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ success: true, data })));
}

function record(name: string, data: unknown = {}) {
  return (...args: unknown[]) => {
    calls.push({ name, args });
    return ok(data);
  };
}

vi.mock('@/shared/api', () => ({
  api: {
    agentTasks: {
      list: (...args: unknown[]) => { calls.push({ name: 'list', args }); return ok(listData); },
      summary: () => ok(summaryData),
      settings: () => ok({ trustAgentMandates: false }),
      saveSettings: (body: { trustAgentMandates: boolean }) => { calls.push({ name: 'saveSettings', args: [body] }); return ok(body); },
      get: () => (detailData ? ok(detailData) : Promise.resolve(new Response(JSON.stringify({ success: false, error: { message: 'Task #12 not found.' } }), { status: 404 }))),
      create: (body: Record<string, unknown>) => { calls.push({ name: 'create', args: [body] }); return ok({ ...task(), id: 42, projectPath: body.projectPath }); },
      update: record('update'),
      remove: record('remove'),
      setStatus: record('setStatus'),
      comment: record('comment'),
      answer: record('answer'),
      confirmMandate: record('confirmMandate'),
      wake: record('wake'),
    },
    channels: {
      approveOutbox: record('approveOutbox'),
      discardOutbox: record('discardOutbox'),
    },
  },
  readApiJson: async (response: Response) => {
    const json = await response.json();
    if (!response.ok) throw new Error(json.error?.message ?? 'Request failed');
    return json;
  },
}));
// The real context hands out one stable subscribe function.
const stableSocket = { subscribe: () => () => {} };
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => stableSocket }));

const { AgentTasksPanel, AgentTasksTabBadge } = await import('@/modules/agent-tasks');
const { default: TaskDetail } = await import('@/modules/agent-tasks/TaskDetail');
const { default: TaskForm } = await import('@/modules/agent-tasks/TaskForm');

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 12,
    title: 'Label printer: three quotes',
    brief: 'Find a printer for our labels.',
    mandate: 'May e-mail up to 8 printers.',
    mandateConfirmed: true,
    summary: '',
    checklist: [],
    status: 'working',
    question: null,
    nextCheckAt: null,
    running: null,
    pendingWake: [],
    failureCount: 0,
    projectPath: '/workspace/ceo_tasks',
    provider: 'claude',
    model: null,
    effort: null,
    permissionMode: 'bypassPermissions',
    ownerUserId: 1,
    createdBy: 'owner',
    createdAt: '2026-10-06T08:00:00.000Z',
    updatedAt: '2026-10-06T09:00:00.000Z',
    closedAt: null,
    draftCount: 0,
    ...overrides,
  };
}

const project = { name: 'ceo_tasks', displayName: 'ceo_tasks', fullPath: '/workspace/ceo_tasks', path: '/workspace/ceo_tasks' } as never;

beforeEach(() => {
  calls.length = 0;
  listData = [];
  detailData = null;
  summaryData = { total: 0, byProject: {} };
});

afterEach(() => cleanup());

test('the board sorts tasks into columns and flags what needs the owner', async () => {
  listData = [
    task({ id: 1, title: 'Waiting on printers', status: 'waiting_external', nextCheckAt: '2026-10-08T07:00:00.000Z' }),
    task({ id: 2, title: 'Pick a printer', status: 'waiting_owner', question: { text: 'Which?', options: ['A', 'B'], by: 'agent', askedAt: '2026-10-07T07:00:00.000Z' } }),
    task({ id: 3, title: 'Agent-made task', status: 'working', mandateConfirmed: false, draftCount: 2 }),
    task({ id: 4, title: 'Old one', status: 'done', closedAt: '2026-10-05T07:00:00.000Z' }),
  ];
  render(<MemoryRouter><AgentTasksPanel selectedProject={project} /></MemoryRouter>);
  await screen.findByText('Pick a printer');

  const needsYou = screen.getByRole('region', { name: 'Needs you' });
  assert.ok(within(needsYou).getByText('Pick a printer'));
  assert.ok(within(needsYou).getByText('Question for you'));
  const working = screen.getByRole('region', { name: 'Working' });
  assert.ok(within(working).getByText('Confirm the mandate'));
  assert.ok(within(working).getByText('2 messages to approve'));
  assert.ok(within(screen.getByRole('region', { name: 'Waiting for a reply' })).getByText(/08\. 10\. 2026 09:00/));
  assert.ok(within(screen.getByRole('region', { name: 'Done' })).getByText('Old one'));
  assert.deepEqual(calls.find((call) => call.name === 'list')?.args, ['/workspace/ceo_tasks', false]);
});

test('on narrow screens the switcher opens on the column that needs you', async () => {
  listData = [
    task({ id: 1, title: 'Busy', status: 'working' }),
    task({ id: 2, title: 'Asks', status: 'waiting_owner', question: { text: 'Which?', options: [], by: 'agent', askedAt: '' } }),
  ];
  render(<MemoryRouter><AgentTasksPanel selectedProject={project} /></MemoryRouter>);
  await screen.findByText('Asks');
  const switcher = screen.getByRole('group', { hidden: true, name: 'Board column' }) ?? null;
  assert.ok(switcher);
  const needsYouPill = within(switcher).getByRole('button', { name: /For you/ });
  assert.equal(needsYouPill.getAttribute('aria-pressed'), 'true');
  // The other columns are hidden below lg until picked.
  assert.match(screen.getByRole('region', { name: 'Working', hidden: true }).className, /\bhidden\b/);
  fireEvent.click(within(switcher).getByRole('button', { name: /Working/ }));
  assert.doesNotMatch(screen.getByRole('region', { name: 'Working' }).className, /(^|\s)hidden(\s|$)/);
});

test('an empty board explains how tasks start', async () => {
  render(<MemoryRouter><AgentTasksPanel selectedProject={project} /></MemoryRouter>);
  assert.ok(await screen.findByText(/No tasks in this project/));
});

test('the tab badge counts tasks that need the owner', async () => {
  summaryData = { total: 3, byProject: { '/workspace/ceo_tasks': 3 } };
  render(<AgentTasksTabBadge />);
  assert.ok(await screen.findByLabelText('3 tasks need you'));
});

test('answering a question sends the chosen option with the note', async () => {
  detailData = {
    task: task({ status: 'waiting_owner', question: { text: 'Which printer?', options: ['Tiskárna A', 'Tiskárna B'], by: 'agent', askedAt: '' } }),
    events: [],
    eventCount: 0,
    messages: [],
  };
  render(<MemoryRouter><TaskDetail taskId={12} onClose={() => {}} onEdit={() => {}} /></MemoryRouter>);
  await screen.findByText('Which printer?');
  fireEvent.change(screen.getByLabelText(/Add a note/), { target: { value: 'ale vyjednej dopravu' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Tiskárna B' })); });
  assert.deepEqual(calls.find((call) => call.name === 'answer')?.args, [12, { option: 'Tiskárna B', text: 'ale vyjednej dopravu' }]);
});

test('an unconfirmed mandate and drafts can be approved from the detail', async () => {
  detailData = {
    task: task({ mandateConfirmed: false, draftCount: 1 }),
    events: [],
    eventCount: 0,
    messages: [{ id: 'out-1', accountId: 'acc', to: 'sales@print.cz', subject: 'Poptávka [#12]', text: 'Dobrý den', status: 'draft', statusDetail: null, createdAt: '', sentAt: null }],
  };
  render(<MemoryRouter><TaskDetail taskId={12} onClose={() => {}} onEdit={() => {}} /></MemoryRouter>);
  await screen.findByText('Confirm the mandate');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm mandate' })); });
  assert.ok(calls.some((call) => call.name === 'confirmMandate'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
  assert.deepEqual(calls.find((call) => call.name === 'approveOutbox')?.args, ['out-1']);
});

test('the summary renders as markdown, the diary newest first with chat links', async () => {
  detailData = {
    task: task({ summary: '| Tiskárna | Cena |\n|---|---|\n| A | 4 200 Kč |', checklist: [{ text: 'Najít tiskárny', done: true }, { text: 'Poptat', done: false }] }),
    events: [
      { id: 1, at: '2026-10-06T08:00:00.000Z', author: 'owner', kind: 'created', text: 'Task created.', meta: null, sessionId: null },
      { id: 2, at: '2026-10-06T08:01:00.000Z', author: 'system', kind: 'wake', text: 'Woke up: created.', meta: null, sessionId: 'chat-1' },
      { id: 3, at: '2026-10-07T08:00:00.000Z', author: 'external', kind: 'message_in', text: 'Od: sales@print.cz\n\n4 200 Kč', meta: null, sessionId: null },
    ],
    eventCount: 3,
    messages: [],
  };
  render(<MemoryRouter><TaskDetail taskId={12} onClose={() => {}} onEdit={() => {}} /></MemoryRouter>);
  const table = await screen.findByRole('table');
  assert.ok(within(table).getByText('4 200 Kč'));
  assert.ok(screen.getByText('Plan · 1/2'));
  const entries = within(screen.getByRole('region', { name: /Diary/ })).getAllByRole('listitem');
  assert.match(entries[0].textContent ?? '', /Incoming/);
  assert.match(entries[1].textContent ?? '', /Woke up — new task/);
  assert.ok(within(entries[1]).getByRole('button', { name: /Open chat/ }));
});

test('a comment wakes the agent; closed tasks offer no composer', async () => {
  detailData = { task: task(), events: [], eventCount: 0, messages: [] };
  const { unmount } = render(<MemoryRouter><TaskDetail taskId={12} onClose={() => {}} onEdit={() => {}} /></MemoryRouter>);
  const box = await screen.findByLabelText('Message the agent');
  fireEvent.change(box, { target: { value: 'Prefer Brno.' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Send to agent/ })); });
  assert.deepEqual(calls.find((call) => call.name === 'comment')?.args, [12, 'Prefer Brno.']);
  unmount();

  detailData = { task: task({ status: 'done', closedAt: '2026-10-06T10:00:00.000Z' }), events: [], eventCount: 0, messages: [] };
  render(<MemoryRouter><TaskDetail taskId={12} onClose={() => {}} onEdit={() => {}} /></MemoryRouter>);
  await screen.findByText(/Closed — move it back/);
  assert.equal(screen.queryByLabelText('Message the agent'), null);
  assert.equal(screen.queryByRole('button', { name: /Wake now/ }), null);
});

test('the form requires a title, a brief and an absolute project, then submits trimmed values', async () => {
  const onSubmit = vi.fn(async () => {});
  render(<TaskForm task={null} projectPath="/workspace/ceo_tasks" onClose={() => {}} onSubmit={onSubmit} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create and start' })); });
  assert.ok(screen.getByText('Give the task a title.'));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: '  Tiskárna  ' } });
  fireEvent.change(screen.getByLabelText(/What should the agent achieve/), { target: { value: 'Tři nabídky' } });
  fireEvent.change(screen.getByLabelText('Agent project'), { target: { value: 'relative' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create and start' })); });
  assert.ok(screen.getByText(/absolute path/));
  fireEvent.change(screen.getByLabelText('Agent project'), { target: { value: '/workspace/ceo_tasks' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create and start' })); });
  await waitFor(() => assert.equal(onSubmit.mock.calls.length, 1));
  const submitted = (onSubmit.mock.calls[0] as unknown as [Record<string, unknown>])[0];
  assert.equal(submitted.title, 'Tiskárna');
  assert.equal(submitted.projectPath, '/workspace/ceo_tasks');
});

test('editing sends only what changed, so a rename never confirms a mandate', async () => {
  const onSubmit = vi.fn(async () => {});
  render(<TaskForm task={task({ mandateConfirmed: false })} projectPath="/workspace/ceo_tasks" onClose={() => {}} onSubmit={onSubmit} />);
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Renamed' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
  await waitFor(() => assert.equal(onSubmit.mock.calls.length, 1));
  assert.deepEqual((onSubmit.mock.calls[0] as unknown as [Record<string, unknown>])[0], { title: 'Renamed' });
});

test('task runs are autonomous: the form offers no permission modes that would hang', () => {
  render(<TaskForm task={null} projectPath="/workspace/ceo_tasks" onClose={() => {}} onSubmit={async () => {}} />);
  assert.equal(screen.queryByLabelText('Permissions'), null);
  assert.ok(screen.getByText(/autonomous/i));
});

test('closing a task from the status menu asks first', async () => {
  detailData = { task: task(), events: [], eventCount: 0, messages: [] };
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<MemoryRouter><TaskDetail taskId={12} onClose={() => {}} onEdit={() => {}} /></MemoryRouter>);
  const select = await screen.findByLabelText('Status');
  await act(async () => { fireEvent.change(select, { target: { value: 'cancelled' } }); });
  assert.equal(confirm.mock.calls.length, 1);
  assert.equal(calls.some((call) => call.name === 'setStatus'), false);
  confirm.mockRestore();
});

test('a task deleted elsewhere shows why instead of a stale card', async () => {
  detailData = { task: task(), events: [], eventCount: 0, messages: [] };
  render(<MemoryRouter><TaskDetail taskId={12} onClose={() => {}} onEdit={() => {}} /></MemoryRouter>);
  const box = await screen.findByLabelText('Message the agent');
  detailData = null;
  fireEvent.change(box, { target: { value: 'Ahoj' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Send to agent/ })); });
  assert.ok(await screen.findByText(/no longer exists/i));
});

test('a card is an article whose title is the button that opens it', async () => {
  listData = [task({ id: 7, title: 'Krabice' })];
  render(<MemoryRouter><AgentTasksPanel selectedProject={project} /></MemoryRouter>);
  const article = await screen.findByRole('article', { name: /Krabice/ });
  assert.ok(within(article).getByRole('button', { name: /Krabice/ }));
});

test('the owner can let agent mandates apply without confirmation', async () => {
  render(<MemoryRouter><AgentTasksPanel selectedProject={project} /></MemoryRouter>);
  const toggle = await screen.findByRole('switch', { name: 'Trust mandates written by agents' });
  await waitFor(() => assert.equal((toggle as HTMLButtonElement).disabled, false));
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  await act(async () => { fireEvent.click(toggle); });
  assert.deepEqual(calls.find((call) => call.name === 'saveSettings')?.args, [{ trustAgentMandates: true }]);
  await waitFor(() => assert.equal(toggle.getAttribute('aria-checked'), 'true'));
});

import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, test, vi } from 'vitest';

import type { Schedule, ScheduleRun } from '@/shared/types';

const previewBodies: Array<Record<string, unknown>> = [];
vi.mock('@/shared/api', () => ({
  api: {
    schedules: {
      preview: (body: Record<string, unknown>) => {
        previewBodies.push(body);
        return Promise.resolve(new Response(JSON.stringify({ success: true, data: { summary: '', nextRuns: [] } })));
      },
      list: () => Promise.resolve(new Response(JSON.stringify({ success: true, data: [] }))),
      runs: () => Promise.resolve(new Response(JSON.stringify({ success: true, data: [] }))),
      summary: () => Promise.resolve(new Response(JSON.stringify({ success: true, data: { proposals: 3, byProject: { '/a': 2, '/b': 1 } } }))),
    },
  },
  readApiJson: async (response: Response) => response.json(),
}));
// The real context hands out one stable subscribe function.
const stableSocket = { subscribe: () => () => {} };
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => stableSocket }));

const { default: RunsTable } = await import('@/modules/schedules/RunsTable');
const { default: ScheduleForm } = await import('@/modules/schedules/ScheduleForm');
const { SchedulesTabBadge, SchedulesPanel } = await import('@/modules/schedules');

afterEach(() => {
  cleanup();
  previewBodies.length = 0;
});

const skippedRun: ScheduleRun = {
  id: 'r1', scheduleId: 's1', scheduleName: 'Pošta', kind: 'script', projectPath: '/a', trigger: 'schedule', scheduledFor: null,
  startedAt: null, finishedAt: '2026-10-06T08:35:00Z', status: 'skipped', sessionId: null, exitCode: null, output: null, hasLog: false,
  error: 'The previous run was still running.', repeatCount: 5,
};

test('folded skips show how many times they happened', () => {
  render(<MemoryRouter><RunsTable runs={[skippedRun]} status="" onStatusChange={() => {}} /></MemoryRouter>);
  assert.ok(screen.getByText('×5'));
});

test('a one-time date in the past is refused in the form', async () => {
  const onSubmit = vi.fn(async () => {});
  render(<ScheduleForm open schedule={null} projectPath="/a" onOpenChange={() => {}} onSubmit={onSubmit} />);
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Jednou' } });
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'p' } });
  fireEvent.click(screen.getByRole('radio', { name: 'Once' }));
  fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: '2020-01-01T08:00' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create schedule' })); });
  assert.equal(onSubmit.mock.calls.length, 0);
  assert.ok(screen.getByText(/in the past/i));
});

test('the preview uses the schedule\'s own time zone', async () => {
  const schedule = {
    id: 's1', name: 'London', projectPath: '/a', kind: 'prompt', enabled: true, proposal: null,
    schedule: { type: 'daily', time: '08:00' }, timezone: 'Europe/London', summary: '', prompt: 'p', provider: 'claude',
    model: null, effort: null, permissionMode: 'bypassPermissions', sessionMode: 'new', sessionId: null, command: '',
    timeoutSec: 1800, handoff: 'none', nextRunAt: null, lastRunAt: null, lastStatus: null, createdAt: '', updatedAt: '',
  } as Schedule;
  render(<ScheduleForm open schedule={schedule} projectPath="/a" onOpenChange={() => {}} onSubmit={async () => {}} />);
  await waitFor(() => assert.ok(previewBodies.length > 0), { timeout: 2000 });
  assert.equal(previewBodies[0].timezone, 'Europe/London');
  assert.ok(screen.getByText(/Europe\/London/));
});

test('the Schedules tab badge counts pending proposals', async () => {
  render(<SchedulesTabBadge />);
  await waitFor(() => assert.ok(screen.getByLabelText('3 schedules waiting for approval')));
});

test('the panel points to proposals waiting in other projects', async () => {
  render(<MemoryRouter><SchedulesPanel selectedProject={{ projectId: 'p', displayName: 'A', fullPath: '/a' }} /></MemoryRouter>);
  await waitFor(() => assert.ok(screen.getByText(/1 proposal waits in another project/i)));
  fireEvent.click(screen.getByRole('button', { name: 'Show all projects' }));
  assert.equal(screen.getByRole('button', { name: 'All projects' }).getAttribute('aria-pressed'), 'true');
});

test('an enabled one-time job with its original (passed) date can still be renamed in the form', async () => {
  const onSubmit = vi.fn(async () => {});
  const schedule = {
    id: 's2', name: 'Retry', projectPath: '/a', kind: 'prompt', enabled: true, proposal: null,
    schedule: { type: 'once', at: '2026-10-06T06:00:00.000Z' }, timezone: 'Europe/Prague', summary: '', prompt: 'p', provider: 'claude',
    model: null, effort: null, permissionMode: 'bypassPermissions', sessionMode: 'new', sessionId: null, command: '',
    timeoutSec: 1800, handoff: 'none', nextRunAt: '2026-10-06T06:01:10.000Z', lastRunAt: null, lastStatus: 'skipped', createdAt: '', updatedAt: '',
  } as Schedule;
  render(<ScheduleForm open schedule={schedule} projectPath="/a" onOpenChange={() => {}} onSubmit={onSubmit} />);
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
  assert.equal(onSubmit.mock.calls.length, 1);
});

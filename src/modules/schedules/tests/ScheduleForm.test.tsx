import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import type { ScheduleInput } from '@/shared/types';

vi.mock('@/shared/api', () => ({
  api: { schedules: { preview: () => Promise.resolve(new Response(JSON.stringify({ success: true, data: { summary: 'Daily at 08:00', nextRuns: [] } }))) } },
  readApiJson: async (response: Response) => response.json(),
}));

const { default: ScheduleForm } = await import('@/modules/schedules/ScheduleForm');

afterEach(() => cleanup());

function renderForm(onSubmit = vi.fn(async (_values: ScheduleInput) => {})) {
  render(<ScheduleForm open schedule={null} projectPath="/workspace/shop" onOpenChange={() => {}} onSubmit={onSubmit} />);
  return onSubmit;
}

test('daily shows only a time; weekly adds the weekday picker', () => {
  renderForm();
  assert.ok(screen.getByRole('radio', { name: 'Daily' }).getAttribute('aria-checked') === 'true');
  assert.equal(screen.queryByRole('group', { name: 'Days of the week' }), null);
  assert.ok(screen.getByLabelText('Time'));

  fireEvent.click(screen.getByRole('radio', { name: 'Weekly' }));
  assert.ok(screen.getByRole('group', { name: 'Days of the week' }));

  fireEvent.click(screen.getByRole('radio', { name: 'Interval' }));
  assert.equal(screen.queryByLabelText('Time'), null, 'an interval has no time of day');
  assert.ok(screen.getByLabelText('Every'));
});

test('weekly without a day is refused; with a day it submits the weekly spec', async () => {
  const onSubmit = renderForm();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Kontrola' } });
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Zkontroluj sklad.' } });
  fireEvent.click(screen.getByRole('radio', { name: 'Weekly' }));

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create schedule' })); });
  assert.equal(onSubmit.mock.calls.length, 0);
  assert.ok(screen.getByText(/at least one day/i));

  fireEvent.click(screen.getByRole('button', { name: 'Tue' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create schedule' })); });
  assert.equal(onSubmit.mock.calls.length, 1);
  const values = onSubmit.mock.calls[0][0];
  assert.deepEqual(values.schedule, { type: 'weekly', days: [2], time: '08:00' });
  assert.equal(values.kind, 'prompt');
  assert.equal(values.projectPath, '/workspace/shop');
});

test('script kind asks for a command and offers the agent hand-off', async () => {
  const onSubmit = renderForm();
  fireEvent.click(screen.getByRole('radio', { name: 'Script' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pošta' } });
  fireEvent.change(screen.getByLabelText('Command'), { target: { value: './scripts/check_mail.py' } });
  assert.equal(screen.queryByLabelText('Hand-off prompt'), null);
  fireEvent.click(screen.getByLabelText(/Hand the output to an agent/));
  assert.ok(screen.getByLabelText('Hand-off prompt'));

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create schedule' })); });
  const values = onSubmit.mock.calls[0][0];
  assert.equal(values.kind, 'script');
  assert.equal(values.command, './scripts/check_mail.py');
  assert.equal(values.handoff, 'on_output');
});

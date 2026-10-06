import assert from 'node:assert/strict';

import { test } from 'vitest';

import { formatDateTime } from '@/shared/utils';
import { describeSchedule, formatDuration } from '@/modules/schedules/utils/scheduleFormat';

test('formatDateTime: European day, date and 24 h time in Prague', () => {
  assert.equal(formatDateTime('2026-10-07T06:00:00.000Z'), 'st 07. 10. 2026 08:00');
  assert.equal(formatDateTime('2026-12-24T17:30:00.000Z'), 'čt 24. 12. 2026 18:30');
  assert.equal(formatDateTime(null), '—');
});

test('formatDuration: seconds, minutes, hours', () => {
  assert.equal(formatDuration('2026-10-06T06:00:00Z', '2026-10-06T06:00:45Z'), '45 s');
  assert.equal(formatDuration('2026-10-06T06:00:00Z', '2026-10-06T06:03:12Z'), '3 min 12 s');
  assert.equal(formatDuration('2026-10-06T06:00:00Z', '2026-10-06T07:05:00Z'), '1 h 05 min');
  assert.equal(formatDuration(null, null), '—');
});

test('describeSchedule mirrors the server summary', () => {
  assert.equal(describeSchedule({ type: 'daily', time: '08:07' }), 'Daily at 08:07');
  assert.equal(describeSchedule({ type: 'weekly', days: [2, 4], time: '08:00' }), 'Every Tuesday, Thursday at 08:00');
  assert.equal(describeSchedule({ type: 'weekly', days: [1, 2, 3, 4, 5], time: '07:00' }), 'Every weekday at 07:00');
  assert.equal(describeSchedule({ type: 'monthly', day: 'last', time: '02:00' }), 'Monthly on the last day at 02:00');
  assert.equal(describeSchedule({ type: 'interval', every: 5, unit: 'minutes' }), 'Every 5 minutes');
  assert.equal(describeSchedule({ type: 'cron', expression: '0 8 * * 1-5' }), 'Cron: 0 8 * * 1-5');
});

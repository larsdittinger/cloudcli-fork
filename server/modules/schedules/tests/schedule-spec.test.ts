import assert from 'node:assert/strict';
import test from 'node:test';

import { describeSchedule, nextRunAfter, nextRuns, parseScheduleSpec } from '@/modules/schedules/schedule-spec.js';

const TZ = 'Europe/Prague';
const iso = (date: Date | null) => date?.toISOString() ?? null;

test('parseScheduleSpec rejects malformed schedules with a readable message', () => {
  assert.throws(() => parseScheduleSpec({ type: 'daily', time: '25:00' }), /time/i);
  assert.throws(() => parseScheduleSpec({ type: 'weekly', days: [], time: '08:00' }), /day/i);
  assert.throws(() => parseScheduleSpec({ type: 'interval', every: 0, unit: 'minutes' }), /interval/i);
  assert.throws(() => parseScheduleSpec({ type: 'cron', expression: 'nope' }), /cron/i);
  assert.throws(() => parseScheduleSpec({ type: 'monthly', day: 32, time: '08:00' }), /day/i);
  assert.throws(() => parseScheduleSpec({ type: 'whenever' }), /type/i);
  assert.deepEqual(parseScheduleSpec({ type: 'weekly', days: [4, 2, 2], time: '8:00' }), { type: 'weekly', days: [2, 4], time: '08:00' });
});

test('daily runs at local wall time (CEST)', () => {
  const spec = parseScheduleSpec({ type: 'daily', time: '08:07' });
  assert.equal(iso(nextRunAfter(spec, TZ, new Date('2026-10-06T07:00:00Z'))), '2026-10-07T06:07:00.000Z');
});

test('daily 02:30 across the October DST change runs once per day at local 02:30', () => {
  const spec = parseScheduleSpec({ type: 'daily', time: '02:30' });
  const runs = nextRuns(spec, TZ, 3, new Date('2026-10-24T12:00:00Z')).map((date) => date.toISOString());
  assert.deepEqual(runs, ['2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z', '2026-10-27T01:30:00.000Z']);
});

test('weekly picks the next listed weekday', () => {
  const spec = parseScheduleSpec({ type: 'weekly', days: [2, 4], time: '08:00' });
  // Monday 2026-10-05 10:00 local → Tuesday 08:00 local
  assert.equal(iso(nextRunAfter(spec, TZ, new Date('2026-10-05T08:00:00Z'))), '2026-10-06T06:00:00.000Z');
  // Sunday is 7
  const sunday = parseScheduleSpec({ type: 'weekly', days: [7], time: '09:00' });
  assert.equal(iso(nextRunAfter(sunday, TZ, new Date('2026-10-05T08:00:00Z'))), '2026-10-11T07:00:00.000Z');
});

test('monthly day 31 falls back to the last day of shorter months', () => {
  const spec = parseScheduleSpec({ type: 'monthly', day: 31, time: '02:00' });
  assert.equal(iso(nextRunAfter(spec, TZ, new Date('2026-11-01T00:00:00Z'))), '2026-11-30T01:00:00.000Z');
  assert.equal(iso(nextRunAfter(spec, TZ, new Date('2026-12-01T00:00:00Z'))), '2026-12-31T01:00:00.000Z');
  const last = parseScheduleSpec({ type: 'monthly', day: 'last', time: '02:00' });
  assert.equal(iso(nextRunAfter(last, TZ, new Date('2027-02-01T00:00:00Z'))), '2027-02-28T01:00:00.000Z');
  const first = parseScheduleSpec({ type: 'monthly', day: 1, time: '02:00' });
  assert.equal(iso(nextRunAfter(first, TZ, new Date('2026-10-06T00:00:00Z'))), '2026-11-01T01:00:00.000Z');
});

test('interval steps from its anchor without drift', () => {
  const spec = parseScheduleSpec({ type: 'interval', every: 5, unit: 'minutes' });
  const anchor = new Date('2026-10-06T10:00:00Z');
  assert.equal(iso(nextRunAfter(spec, TZ, new Date('2026-10-06T10:12:30Z'), anchor)), '2026-10-06T10:15:00.000Z');
  assert.equal(iso(nextRunAfter(spec, TZ, new Date('2026-10-06T10:00:00Z'), anchor)), '2026-10-06T10:05:00.000Z');
  const hourly = parseScheduleSpec({ type: 'interval', every: 2, unit: 'hours' });
  assert.equal(iso(nextRunAfter(hourly, TZ, new Date('2026-10-06T10:00:01Z'), null)), '2026-10-06T12:00:01.000Z');
});

test('once runs only in the future', () => {
  const spec = parseScheduleSpec({ type: 'once', at: '2026-10-07T06:00:00Z' });
  assert.equal(iso(nextRunAfter(spec, TZ, new Date('2026-10-06T00:00:00Z'))), '2026-10-07T06:00:00.000Z');
  assert.equal(nextRunAfter(spec, TZ, new Date('2026-10-08T00:00:00Z')), null);
});

test('cron uses the time zone', () => {
  const spec = parseScheduleSpec({ type: 'cron', expression: '0 8 * * 1-5' });
  assert.equal(iso(nextRunAfter(spec, TZ, new Date('2026-10-10T00:00:00Z'))), '2026-10-12T06:00:00.000Z');
});

test('describeSchedule reads like a sentence', () => {
  assert.equal(describeSchedule(parseScheduleSpec({ type: 'daily', time: '08:07' })), 'Daily at 08:07');
  assert.equal(describeSchedule(parseScheduleSpec({ type: 'weekly', days: [2, 4], time: '08:00' })), 'Every Tuesday, Thursday at 08:00');
  assert.equal(describeSchedule(parseScheduleSpec({ type: 'weekly', days: [1, 2, 3, 4, 5], time: '07:00' })), 'Every weekday at 07:00');
  assert.equal(describeSchedule(parseScheduleSpec({ type: 'monthly', day: 31, time: '02:00' })), 'Monthly on day 31 (or the last day) at 02:00');
  assert.equal(describeSchedule(parseScheduleSpec({ type: 'monthly', day: 'last', time: '02:00' })), 'Monthly on the last day at 02:00');
  assert.equal(describeSchedule(parseScheduleSpec({ type: 'interval', every: 5, unit: 'minutes' })), 'Every 5 minutes');
  assert.equal(describeSchedule(parseScheduleSpec({ type: 'interval', every: 1, unit: 'hours' })), 'Every hour');
  assert.equal(describeSchedule(parseScheduleSpec({ type: 'cron', expression: '0 8 * * 1-5' })), 'Cron: 0 8 * * 1-5');
});

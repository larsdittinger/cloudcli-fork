import { Cron } from 'croner';

import { AppError } from '@/shared/utils.js';

/**
 * When a schedule fires. Stored as JSON on the schedule row; `time` is local
 * wall time in the schedule's IANA time zone, weekdays are 1 = Monday … 7 = Sunday.
 */
export type ScheduleSpec =
  | { type: 'once'; at: string }
  | { type: 'interval'; every: number; unit: 'minutes' | 'hours' }
  | { type: 'daily'; time: string }
  | { type: 'weekly'; days: number[]; time: string }
  | { type: 'monthly'; day: number | 'last'; time: string }
  | { type: 'cron'; expression: string };

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MAX_INTERVAL = 1000;

function invalid(message: string): never {
  throw new AppError(message, { code: 'SCHEDULE_INVALID', statusCode: 400 });
}

function parseTime(value: unknown): string {
  const match = typeof value === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(value.trim()) : null;
  const hours = match ? Number(match[1]) : NaN;
  const minutes = match ? Number(match[2]) : NaN;
  if (!match || hours > 23 || minutes > 59) invalid('Time must be HH:mm between 00:00 and 23:59.');
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Used by the schedules service, MCP and plugin import to validate whatever the form or an agent sent. */
export function parseScheduleSpec(value: unknown): ScheduleSpec {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  switch (input.type) {
    case 'once': {
      const at = new Date(String(input.at ?? ''));
      if (Number.isNaN(at.getTime())) invalid('A one-time schedule needs a valid date and time.');
      return { type: 'once', at: at.toISOString() };
    }
    case 'interval': {
      const every = Number(input.every);
      const unit = input.unit === 'hours' ? 'hours' : input.unit === 'minutes' ? 'minutes' : null;
      if (!unit || !Number.isInteger(every) || every < 1 || every > MAX_INTERVAL) {
        invalid(`The interval must be a whole number of minutes or hours between 1 and ${MAX_INTERVAL}.`);
      }
      return { type: 'interval', every, unit };
    }
    case 'daily':
      return { type: 'daily', time: parseTime(input.time) };
    case 'weekly': {
      const days = Array.isArray(input.days) ? [...new Set(input.days.map(Number))].sort((a, b) => a - b) : [];
      if (days.length === 0 || days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
        invalid('Pick at least one day of the week (1 = Monday … 7 = Sunday).');
      }
      return { type: 'weekly', days, time: parseTime(input.time) };
    }
    case 'monthly': {
      const day = input.day === 'last' ? 'last' : Number(input.day);
      if (day !== 'last' && (!Number.isInteger(day) || day < 1 || day > 31)) invalid('The day of the month must be 1–31 or "last".');
      return { type: 'monthly', day, time: parseTime(input.time) };
    }
    case 'cron': {
      const expression = String(input.expression ?? '').trim().replace(/\s+/g, ' ');
      if (expression.split(' ').length !== 5) invalid('A cron expression has 5 fields: minute hour day-of-month month day-of-week.');
      try {
        new Cron(expression, { paused: true });
      } catch (error) {
        invalid(`Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { type: 'cron', expression };
    }
    default:
      return invalid('Unknown schedule type (once, interval, daily, weekly, monthly or cron).');
  }
}

/** Used by the schedules service to validate a time zone before saving. */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function cronNext(expression: string, timezone: string, after: Date): Date | null {
  return new Cron(expression, { timezone, paused: true }).nextRun(after) ?? null;
}

function localDayInfo(date: Date, timezone: string): { day: number; daysInMonth: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const year = read('year');
  const month = read('month');
  return { day: read('day'), daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate() };
}

function timeFields(time: string): { hour: number; minute: number } {
  const [hour, minute] = time.split(':').map(Number);
  return { hour, minute };
}

/**
 * The first run strictly after `after`. `anchor` is the previous planned run of
 * an interval schedule, so intervals keep their rhythm instead of drifting by
 * however late the ticker was.
 */
export function nextRunAfter(spec: ScheduleSpec, timezone: string, after: Date, anchor: Date | null = null): Date | null {
  switch (spec.type) {
    case 'once': {
      const at = new Date(spec.at);
      return at.getTime() > after.getTime() ? at : null;
    }
    case 'interval': {
      const step = spec.every * (spec.unit === 'hours' ? 3_600_000 : 60_000);
      const base = (anchor ?? after).getTime();
      const steps = Math.max(1, Math.floor((after.getTime() - base) / step) + 1);
      return new Date(base + steps * step);
    }
    case 'daily': {
      const { hour, minute } = timeFields(spec.time);
      return cronNext(`${minute} ${hour} * * *`, timezone, after);
    }
    case 'weekly': {
      const { hour, minute } = timeFields(spec.time);
      // croner counts Sunday as 0.
      const days = spec.days.map((day) => (day === 7 ? 0 : day)).join(',');
      return cronNext(`${minute} ${hour} * * ${days}`, timezone, after);
    }
    case 'monthly': {
      const { hour, minute } = timeFields(spec.time);
      if (spec.day !== 'last' && spec.day <= 28) return cronNext(`${minute} ${hour} ${spec.day} * *`, timezone, after);
      // Day 29–31 or "last": the wanted day in each month is min(day, days in that month).
      let cursor = after;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const candidate = cronNext(`${minute} ${hour} 28-31 * *`, timezone, cursor);
        if (!candidate) return null;
        const { day, daysInMonth } = localDayInfo(candidate, timezone);
        const wanted = spec.day === 'last' ? daysInMonth : Math.min(spec.day, daysInMonth);
        if (day === wanted) return candidate;
        cursor = candidate;
      }
      return null;
    }
    case 'cron':
      return cronNext(spec.expression, timezone, after);
  }
}

/** Used by the preview endpoint and agent info to show the coming runs. */
export function nextRuns(spec: ScheduleSpec, timezone: string, count: number, from: Date = new Date()): Date[] {
  const runs: Date[] = [];
  let cursor = from;
  let anchor: Date | null = null;
  while (runs.length < count) {
    const next = nextRunAfter(spec, timezone, cursor, anchor);
    if (!next) break;
    runs.push(next);
    cursor = next;
    anchor = next;
  }
  return runs;
}

function formatLocal(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('cs-CZ', {
    timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

/** Used by the schedules service for the one-line summary shown on cards and to agents. */
export function describeSchedule(spec: ScheduleSpec, timezone = 'Europe/Prague'): string {
  switch (spec.type) {
    case 'once':
      return `Once on ${formatLocal(spec.at, timezone)}`;
    case 'interval':
      return spec.every === 1 ? `Every ${spec.unit === 'hours' ? 'hour' : 'minute'}` : `Every ${spec.every} ${spec.unit}`;
    case 'daily':
      return `Daily at ${spec.time}`;
    case 'weekly': {
      const label = spec.days.join(',') === '1,2,3,4,5' ? 'weekday'
        : spec.days.join(',') === '6,7' ? 'weekend day'
          : spec.days.length === 7 ? 'day'
            : spec.days.map((day) => DAY_NAMES[day - 1]).join(', ');
      return `Every ${label} at ${spec.time}`;
    }
    case 'monthly':
      return spec.day === 'last'
        ? `Monthly on the last day at ${spec.time}`
        : `Monthly on day ${spec.day}${spec.day > 28 ? ' (or the last day)' : ''} at ${spec.time}`;
    case 'cron':
      return `Cron: ${spec.expression}`;
  }
}

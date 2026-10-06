import type { ScheduleSpec } from '@/shared/types';

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const dateTimeFormat = new Intl.DateTimeFormat('cs-CZ', {
  timeZone: 'Europe/Prague',
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** `st 07. 10. 2026 08:00` — European order, 24 h, Prague time; `—` for nothing. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = dateTimeFormat.formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('weekday')} ${read('day')}. ${read('month')}. ${read('year')} ${read('hour')}:${read('minute')}`;
}

/** `45 s`, `3 min 12 s`, `1 h 05 min`; `—` while either end is missing. */
export function formatDuration(startIso: string | null | undefined, endIso: string | null | undefined): string {
  if (!startIso || !endIso) return '—';
  const seconds = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** Instant summary while the form is edited; the server's `summary` is authoritative once saved. */
export function describeSchedule(spec: ScheduleSpec): string {
  switch (spec.type) {
    case 'once':
      return `Once on ${formatDateTime(spec.at)}`;
    case 'interval':
      return spec.every === 1 ? `Every ${spec.unit === 'hours' ? 'hour' : 'minute'}` : `Every ${spec.every} ${spec.unit}`;
    case 'daily':
      return `Daily at ${spec.time}`;
    case 'weekly': {
      const key = [...spec.days].sort().join(',');
      const label = key === '1,2,3,4,5' ? 'weekday' : key === '6,7' ? 'weekend day' : spec.days.length === 7 ? 'day'
        : [...spec.days].sort().map((day) => DAY_NAMES[day - 1]).join(', ');
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

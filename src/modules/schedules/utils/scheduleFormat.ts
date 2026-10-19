import { i18n } from '@/modules/i18n';
import type { ScheduleSpec } from '@/shared/types';
import { formatDateTime } from '@/shared/utils';

/**
 * Weekday 1 (Monday) … 7 (Sunday) in the UI language, from `Intl` so no
 * language needs its own list. 1 January 2024 was a Monday.
 */
export function weekdayName(day: number, width: 'long' | 'short'): string {
  return new Intl.DateTimeFormat(i18n.language || 'en', { weekday: width, timeZone: 'UTC' }).format(Date.UTC(2024, 0, day));
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
  const t = i18n.getFixedT(null, 'schedules');
  switch (spec.type) {
    case 'once':
      return t('describe.once', { date: formatDateTime(spec.at) });
    case 'interval':
      return t(spec.unit === 'hours' ? 'describe.everyHours' : 'describe.everyMinutes', { count: spec.every });
    case 'daily':
      return t('describe.daily', { time: spec.time });
    case 'weekly': {
      const key = [...spec.days].sort().join(',');
      if (key === '1,2,3,4,5') return t('describe.weekdays', { time: spec.time });
      if (key === '6,7') return t('describe.weekend', { time: spec.time });
      if (spec.days.length === 7) return t('describe.everyDay', { time: spec.time });
      const days = [...spec.days].sort().map((day) => weekdayName(day, 'long')).join(', ');
      return t('describe.days', { days, time: spec.time });
    }
    case 'monthly':
      if (spec.day === 'last') return t('describe.monthlyLast', { time: spec.time });
      return t(spec.day > 28 ? 'describe.monthlyDayOrLast' : 'describe.monthlyDay', { day: spec.day, time: spec.time });
    case 'cron':
      return t('describe.cron', { expression: spec.expression });
  }
}

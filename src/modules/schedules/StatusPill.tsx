import { cn } from '@/shared/utils';

const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  running: { label: 'Running', className: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300' },
  succeeded: { label: 'Succeeded', className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  failed: { label: 'Failed', className: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300' },
  timeout: { label: 'Timed out', className: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200' },
  skipped: { label: 'Skipped', className: 'border-border bg-muted/50 text-muted-foreground' },
  missed: { label: 'Missed', className: 'border-border bg-muted/50 text-muted-foreground' },
};

/** Used by ScheduleCard and RunsTable: one consistent color per run status; a running run pulses. */
export default function StatusPill({ status }: { status: string | null }) {
  if (!status) return <span className="text-xs text-muted-foreground">Never ran</span>;
  const style = STATUS_STYLE[status] ?? { label: status, className: 'border-border text-muted-foreground' };
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium', style.className)}>
      {status === 'running' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" aria-hidden />}
      {style.label}
    </span>
  );
}

import { Bot, TerminalSquare } from 'lucide-react';

import { cn } from '@/shared/utils';

/** Used by ScheduleCard and RunsTable: AI work is violet (as background agents are elsewhere), scripts stay neutral. */
export default function KindLabel({ kind, handoff, compact = false }: { kind: 'prompt' | 'script' | null; handoff?: boolean; compact?: boolean }) {
  if (!kind) return <span className="text-xs text-muted-foreground">—</span>;
  const label = kind === 'prompt' ? 'AI prompt' : handoff ? 'Script → AI' : 'Script';
  const Icon = kind === 'prompt' ? Bot : TerminalSquare;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap text-xs',
        kind === 'prompt' || handoff ? 'text-violet-700 dark:text-violet-300' : 'text-muted-foreground',
      )}
      title={label}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {compact ? null : label}
    </span>
  );
}

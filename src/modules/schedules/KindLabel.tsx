import { Bot, TerminalSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';

/** Used by ScheduleCard and RunsTable: AI work is violet (as background agents are elsewhere), scripts stay neutral. */
export default function KindLabel({ kind, handoff, compact = false }: { kind: 'prompt' | 'script' | null; handoff?: boolean; compact?: boolean }) {
  const { t } = useTranslation('schedules');
  if (!kind) return <span className="text-xs text-muted-foreground">—</span>;
  const label = t(kind === 'prompt' ? 'kind.prompt' : handoff ? 'kind.scriptHandoff' : 'kind.script');
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

import type { LucideIcon } from 'lucide-react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import { Button } from '@/shared/ui/Button';

export type BulkAction = {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  isDanger?: boolean;
  disabled?: boolean;
};

type BulkActionBarProps = {
  /** How many rows are picked; the bar says so and its actions apply to them. */
  count: number;
  /** The whole "N messages selected" sentence, pluralised by the caller's namespace. */
  selectedLabel: string;
  actions: BulkAction[];
  onSelectAll?: () => void;
  onClear: () => void;
  busy?: boolean;
  className?: string;
};

/** Used by the channels Inbox and the agent-tasks boards: the bar of actions for the rows picked with multi-select. */
export function BulkActionBar({ count, selectedLabel, actions, onSelectAll, onClear, busy = false, className }: BulkActionBarProps) {
  const { t } = useTranslation('common');
  return (
    <div
      role="toolbar"
      aria-label={t('bulkActions.selectedItems')}
      className={cn('flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-2 py-1.5 text-sm', className)}
    >
      <span className="font-medium tabular-nums">{selectedLabel}</span>
      {onSelectAll && (
        <Button size="sm" variant="ghost" className="h-7 px-2" disabled={busy} onClick={onSelectAll}>{t('bulkActions.selectAll')}</Button>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-1">
        {actions.map(({ key, label, icon: Icon, onSelect, isDanger, disabled }) => (
          <Button
            key={key}
            size="sm"
            variant={isDanger ? 'destructive' : 'outline'}
            className="h-7 px-2"
            disabled={busy || disabled || count === 0}
            onClick={onSelect}
          >
            <Icon className="mr-1 h-3.5 w-3.5" aria-hidden /> {label}
          </Button>
        ))}
        <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={t('bulkActions.clearSelection')} disabled={busy} onClick={onClear}>
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

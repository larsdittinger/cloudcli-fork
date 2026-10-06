import { cn } from '@/shared/utils';

type SwitchProps = {
  checked: boolean;
  onChange: (value: boolean) => void;
  /** Accessible name; usually the visible label next to it. */
  label: string;
  disabled?: boolean;
};

/** Used by the schedules and agent-tasks modules for an on/off setting inside a workspace tab. */
export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 touch-manipulation items-center rounded-full border-2 transition-colors duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        checked ? 'border-primary bg-primary' : 'border-border bg-muted',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-3.5 w-3.5 rounded-full shadow-sm transition-transform duration-200',
          checked ? 'translate-x-[16px] bg-white' : 'translate-x-[2px] bg-foreground/60 dark:bg-foreground/80',
        )}
      />
    </button>
  );
}

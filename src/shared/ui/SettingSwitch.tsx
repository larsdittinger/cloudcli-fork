import { useEffect, useState } from 'react';

import { Switch } from '@/shared/ui/Switch';

type SettingSwitchProps = {
  label: string;
  /** One sentence on what changes when it is on. */
  description: string;
  /** Reads the current value from the server. */
  load: () => Promise<boolean>;
  /** Stores a new value; resolves with what the server kept. */
  save: (value: boolean) => Promise<boolean>;
};

/**
 * Used by the schedules and agent-tasks modules for the owner's "agents may do
 * this without approval" switches: a labelled switch backed by a server setting.
 */
export function SettingSwitch({ label, description, load, save }: SettingSwitchProps) {
  // The server's value; null until the first load answers (the switch stays disabled meanwhile).
  const [value, setValue] = useState<boolean | null>(null);
  // True while a change is being saved.
  const [saving, setSaving] = useState(false);
  // Why the last load or save failed.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    load()
      .then((loaded) => { if (active) setValue(loaded); })
      .catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : String(err)); });
    return () => { active = false; };
  }, [load]);

  const change = async (next: boolean) => {
    setSaving(true);
    setError(null);
    try {
      setValue(await save(next));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-start gap-3 rounded-lg border border-border/60 px-3 py-2.5">
      <Switch checked={value === true} onChange={(next) => void change(next)} label={label} disabled={value === null || saving} />
      <div className="min-w-0 text-sm">
        <p className="font-medium leading-5">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
        {error && <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-300">{error}</p>}
      </div>
    </div>
  );
}

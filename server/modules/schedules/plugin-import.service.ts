import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appConfigDb } from '@/modules/database/index.js';
import { schedulesService } from '@/modules/schedules/schedules.service.js';

const IMPORTED_KEY = 'schedules_imported_cron_plugin';
const CRON_PLUGIN_NAME = 'workspace-scheduled-prompts';
const DEFAULT_LEDGER_DIR = path.join(os.homedir(), '.cloudcli-workspace-scheduled-prompts');
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

type PluginTask = { name?: unknown; prompt?: unknown; enabled?: unknown; recurrence?: Record<string, unknown> };

function weekday(name: unknown): number {
  return WEEKDAYS.indexOf(String(name).toLowerCase()) + 1;
}

/** The plugin's recurrence → our ScheduleSpec, or null for what has nothing left to run. */
function toSpec(recurrence: Record<string, unknown>): unknown {
  const time = recurrence.localTime;
  switch (recurrence.scheduleType) {
    case 'daily':
      return { type: 'daily', time };
    case 'weekdays':
      return { type: 'weekly', days: (Array.isArray(recurrence.weekdays) ? recurrence.weekdays : []).map(weekday), time };
    case 'weekly':
      return { type: 'weekly', days: [weekday(recurrence.dayOfWeek)], time };
    case 'monthly':
      return { type: 'monthly', day: Number(recurrence.dayOfMonth), time };
    case 'one_time': {
      const at = new Date(String(recurrence.runAt ?? ''));
      return at.getTime() > Date.now() ? { type: 'once', at: at.toISOString() } : null;
    }
    default:
      return null;
  }
}

/**
 * Used by the schedules module at start, once per instance: copies the tasks of
 * the `workspace-scheduled-prompts` plugin (ledgers in ~/.cloudcli-workspace-scheduled-prompts)
 * into Schedules and switches the plugin off so nothing runs twice. The plugin
 * ran `claude -p --dangerously-skip-permissions`, hence bypassPermissions.
 * Returns how many schedules were created.
 */
export async function importCronPluginSchedules(options: {
  ledgerDir?: string;
  isPluginEnabled: (name: string) => boolean;
  disablePlugin: (name: string) => Promise<void>;
}): Promise<number> {
  if (appConfigDb.get(IMPORTED_KEY)) return 0;
  const ledgerDir = options.ledgerDir ?? DEFAULT_LEDGER_DIR;
  if (!fs.existsSync(ledgerDir)) {
    appConfigDb.set(IMPORTED_KEY, new Date().toISOString());
    return 0;
  }

  // Switch the plugin off first: if that fails nothing is imported (no task may run
  // twice) and the next start tries again. Tasks of a plugin that was already off
  // come over paused, so nothing starts running that was not running before.
  const pluginWasEnabled = options.isPluginEnabled(CRON_PLUGIN_NAME);
  await options.disablePlugin(CRON_PLUGIN_NAME);

  let imported = 0;
  for (const file of fs.readdirSync(ledgerDir).filter((name) => name.endsWith('.json'))) {
    let ledger: { workspacePath?: unknown; tasks?: unknown };
    try {
      ledger = JSON.parse(fs.readFileSync(path.join(ledgerDir, file), 'utf8'));
    } catch {
      console.warn(`[Schedules] Skipping unreadable cron plugin ledger ${file}`);
      continue;
    }
    const tasks = Array.isArray(ledger.tasks) ? ledger.tasks as PluginTask[] : [];
    for (const task of tasks) {
      const recurrence = task.recurrence ?? {};
      const spec = toSpec(recurrence);
      if (!spec) {
        console.warn(`[Schedules] Not importing "${String(task.name)}": ${String(recurrence.scheduleType)} has nothing left to run`);
        continue;
      }
      try {
        schedulesService.create({
          name: task.name,
          projectPath: ledger.workspacePath,
          kind: 'prompt',
          prompt: task.prompt,
          schedule: spec,
          timezone: recurrence.timezone,
          permissionMode: 'bypassPermissions',
          enabled: pluginWasEnabled && task.enabled !== false,
        }, null);
        imported += 1;
      } catch (error) {
        console.warn(`[Schedules] Could not import "${String(task.name)}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  appConfigDb.set(IMPORTED_KEY, new Date().toISOString());
  console.log(`[Schedules] Imported ${imported} schedule(s) from the cron plugin and switched it off`);
  return imported;
}

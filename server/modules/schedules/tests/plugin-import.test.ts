import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { schedulesDb } from '@/modules/database/index.js';
import { importCronPluginSchedules } from '@/modules/schedules/plugin-import.service.js';
import { withIsolatedDatabase } from '@/modules/schedules/tests/helpers.js';

function writeLedger(dir: string, name: string, workspacePath: string, tasks: unknown[]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, workspacePath, tasks, runs: [] }));
}

test('imports the cron plugin ledgers once and switches the plugin off', async () => {
  await withIsolatedDatabase(async (dir) => {
    const ledgerDir = path.join(dir, 'ledgers');
    writeLedger(ledgerDir, 'a.json', '/workspace/email_support', [
      { id: 't1', name: 'spam cron email', prompt: 'Smaž spam.', enabled: true, recurrence: { scheduleType: 'daily', localTime: '06:00', timezone: 'Europe/Prague' } },
      { id: 't2', name: 'UT hlídání skladu', prompt: 'Hlídej sklad.', enabled: true, recurrence: { scheduleType: 'weekdays', weekdays: ['tuesday'], localTime: '02:00', timezone: 'Europe/Prague' } },
      { id: 't3', name: 'Past one-off', prompt: 'x', enabled: true, recurrence: { scheduleType: 'one_time', runAt: '2020-01-01T00:00:00Z', timezone: 'Europe/Prague' } },
    ]);
    writeLedger(ledgerDir, 'b.json', '/home/claude/dev/ads', [
      { id: 't4', name: 'Aktualizace bestpractice.md', prompt: 'Rešerše.', enabled: false, recurrence: { scheduleType: 'monthly', dayOfMonth: 1, localTime: '02:00', timezone: 'Europe/Prague' } },
      { id: 't5', name: 'Weekly', prompt: 'w', enabled: true, recurrence: { scheduleType: 'weekly', dayOfWeek: 'sunday', localTime: '09:00', timezone: 'Europe/Prague' } },
    ]);
    fs.writeFileSync(path.join(ledgerDir, 'broken.json'), '{ nope');
    const disabled: string[] = [];

    const imported = await importCronPluginSchedules({ ledgerDir, isPluginEnabled: () => true, disablePlugin: async (name) => { disabled.push(name); } });
    assert.equal(imported, 4, 'the past one-time task is skipped');
    assert.deepEqual(disabled, ['workspace-scheduled-prompts']);

    const rows = schedulesDb.list();
    const byName = new Map(rows.map((row) => [row.name, row]));
    assert.deepEqual(JSON.parse(byName.get('spam cron email')!.schedule), { type: 'daily', time: '06:00' });
    assert.equal(byName.get('spam cron email')!.project_path, '/workspace/email_support');
    assert.equal(byName.get('spam cron email')!.permission_mode, 'bypassPermissions');
    assert.equal(byName.get('spam cron email')!.kind, 'prompt');
    assert.ok(byName.get('spam cron email')!.next_run_at, 'enabled imports are planned');
    assert.deepEqual(JSON.parse(byName.get('UT hlídání skladu')!.schedule), { type: 'weekly', days: [2], time: '02:00' });
    assert.deepEqual(JSON.parse(byName.get('Weekly')!.schedule), { type: 'weekly', days: [7], time: '09:00' });
    assert.deepEqual(JSON.parse(byName.get('Aktualizace bestpractice.md')!.schedule), { type: 'monthly', day: 1, time: '02:00' });
    assert.equal(byName.get('Aktualizace bestpractice.md')!.enabled, 0);

    assert.equal(await importCronPluginSchedules({ ledgerDir, isPluginEnabled: () => true, disablePlugin: async (name) => { disabled.push(name); } }), 0, 'runs only once');
    assert.equal(schedulesDb.list().length, 4);
  });
});

test('no ledger directory: nothing imported, plugin left alone', async () => {
  await withIsolatedDatabase(async (dir) => {
    const disabled: string[] = [];
    assert.equal(await importCronPluginSchedules({ ledgerDir: path.join(dir, 'missing'), isPluginEnabled: () => true, disablePlugin: async (name) => { disabled.push(name); } }), 0);
    assert.deepEqual(disabled, []);
  });
});

test('if the plugin cannot be switched off nothing is imported and the next start retries', async () => {
  await withIsolatedDatabase(async (dir) => {
    const ledgerDir = path.join(dir, 'ledgers');
    writeLedger(ledgerDir, 'a.json', '/workspace/shop', [
      { id: 't1', name: 'Daily', prompt: 'p', enabled: true, recurrence: { scheduleType: 'daily', localTime: '06:00', timezone: 'Europe/Prague' } },
    ]);
    await assert.rejects(importCronPluginSchedules({ ledgerDir, isPluginEnabled: () => true, disablePlugin: async () => { throw new Error('config is read-only'); } }));
    assert.equal(schedulesDb.list().length, 0, 'no schedule may run next to the still-active plugin');

    assert.equal(await importCronPluginSchedules({ ledgerDir, isPluginEnabled: () => true, disablePlugin: async () => {} }), 1);
    assert.equal(schedulesDb.list().length, 1);
  });
});

test('tasks of a plugin that was switched off are imported paused', async () => {
  await withIsolatedDatabase(async (dir) => {
    const ledgerDir = path.join(dir, 'ledgers');
    writeLedger(ledgerDir, 'a.json', '/workspace/shop', [
      { id: 't1', name: 'Daily', prompt: 'p', enabled: true, recurrence: { scheduleType: 'daily', localTime: '06:00', timezone: 'Europe/Prague' } },
    ]);
    assert.equal(await importCronPluginSchedules({ ledgerDir, isPluginEnabled: () => false, disablePlugin: async () => {} }), 1);
    const row = schedulesDb.list()[0];
    assert.equal(row.enabled, 0);
    assert.equal(row.next_run_at, null);
  });
});

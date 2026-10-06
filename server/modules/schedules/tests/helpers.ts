import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import type { ScheduleWrite } from '@/modules/database/index.js';

/** Runs a test against a fresh SQLite file so nothing leaks between tests. */
export async function withIsolatedDatabase(runTest: (tempDirectory: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'schedules-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest(tempDirectory);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** A valid daily prompt schedule; override what the test cares about. */
export function scheduleInput(overrides: Partial<ScheduleWrite> = {}): ScheduleWrite {
  return {
    name: 'Daily check',
    project_path: '/workspace/shop',
    kind: 'prompt',
    enabled: true,
    proposal: null,
    schedule: JSON.stringify({ type: 'daily', time: '08:00' }),
    timezone: 'Europe/Prague',
    prompt: 'Check the shop.',
    provider: 'claude',
    model: null,
    effort: null,
    permission_mode: 'bypassPermissions',
    session_mode: 'new',
    command: '',
    timeout_sec: 1800,
    handoff: 'none',
    next_run_at: '2026-10-07T06:00:00.000Z',
    owner_user_id: null,
    ...overrides,
  };
}

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import type { TaskWrite } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

/** Runs a test against a fresh SQLite file so nothing leaks between tests. */
export async function withIsolatedDatabase(runTest: (tempDirectory: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'tasks-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest(tempDirectory);
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

export type RuntimeCall = { provider: string; command: string; options: Record<string, unknown> };

/**
 * A provider runtime that records each turn instead of starting a CLI.
 * `onRun` lets a test act as the agent during the turn (call tools, wait).
 */
export function fakeRuntime(calls: RuntimeCall[], onRun?: (call: RuntimeCall) => void | Promise<void>) {
  return {
    hasRuntime: () => true,
    run: async (provider: string, command: string, options: Record<string, unknown>) => {
      const call = { provider, command, options };
      calls.push(call);
      await onRun?.(call);
    },
    abort: async () => true,
  } as never;
}

/** A confirmed task owned by Lars in /workspace/shop; override what the test cares about. */
export function taskInput(overrides: Partial<TaskWrite> = {}): TaskWrite {
  return {
    title: 'Find a label printer',
    brief: 'Find three printers for our labels and get prices for 1000 pcs.',
    mandate: 'May email up to 5 printers asking for a quote. No orders.',
    mandate_confirmed: 1,
    status: 'new',
    project_path: '/workspace/shop',
    provider: 'claude',
    model: null,
    effort: null,
    permission_mode: 'bypassPermissions',
    owner_user_id: null,
    created_by: 'owner',
    next_check_at: null,
    question: null,
    ...overrides,
  };
}

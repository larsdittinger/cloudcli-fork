import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { InboundMessage } from '@/modules/channels/types.js';

/** Runs a test against a fresh SQLite file so nothing leaks between tests. */
export async function withIsolatedDatabase(runTest: (tempDirectory: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'channels-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest(tempDirectory);
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

let counter = 0;

export function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  counter += 1;
  return {
    id: `msg-${counter}-${Math.random().toString(16).slice(2)}`,
    accountId: 'acc-1',
    channel: 'email',
    externalId: `ext-${counter}`,
    threadKey: `thread-${counter}`,
    from: { address: 'jan@firma.cz', name: 'Jan Novak' },
    to: ['me@example.com'],
    subject: 'Objednavka',
    text: 'Dobry den, chci objednat.',
    isGroup: false,
    attachments: [],
    receivedAt: new Date(Date.now() + counter * 1000).toISOString(),
    raw: {},
    ...overrides,
  };
}

export type RunCall = { provider: string; command: string; options: Record<string, unknown> };

export function createRuntime(runs: RunCall[], behaviour: 'ok' | 'throw' = 'ok') {
  return {
    hasRuntime: () => true,
    run: async (provider: string, command: string, options: Record<string, unknown>) => {
      if (behaviour === 'throw') {
        throw new Error('provider exploded');
      }
      runs.push({ provider, command, options });
    },
    abort: async () => true,
  } as never;
}

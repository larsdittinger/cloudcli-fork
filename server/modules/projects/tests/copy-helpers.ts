import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';

const ISOLATION_ENV = ['CLOUDCLI_ISOLATED_ROOT', 'CLOUDCLI_ISOLATED_HOMES', 'CLOUDCLI_ISOLATION_DIR', 'CLOUDCLI_SANDBOX_DAEMON_TOKEN'] as const;

/** Runs a test against a fresh SQLite file in a temp directory (realpath: macOS tmp is behind a symlink). */
export async function withTempDatabase(runTest: (tempDirectory: string) => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const tempDirectory = fs.realpathSync(await mkdtemp(path.join(os.tmpdir(), 'copy-')));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest(tempDirectory);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Sets (or, with `null`, clears) the isolation env for one test and restores it afterwards. */
export async function withIsolationDirs(dir: string | null, runTest: () => void | Promise<void>): Promise<void> {
  const previous = Object.fromEntries(ISOLATION_ENV.map((key) => [key, process.env[key]]));
  for (const key of ISOLATION_ENV) delete process.env[key];
  if (dir) {
    for (const [key, sub] of [['CLOUDCLI_ISOLATED_ROOT', 'isolated'], ['CLOUDCLI_ISOLATED_HOMES', 'homes'], ['CLOUDCLI_ISOLATION_DIR', 'iso']] as const) {
      process.env[key] = path.join(dir, sub);
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
    }
    process.env.CLOUDCLI_SANDBOX_DAEMON_TOKEN = 'daemon-token';
  }
  try {
    await runTest();
  } finally {
    for (const key of ISOLATION_ENV) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

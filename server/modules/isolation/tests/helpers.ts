import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';

const ISOLATION_ENV = ['CLOUDCLI_ISOLATED_ROOT', 'CLOUDCLI_ISOLATED_HOMES', 'CLOUDCLI_ISOLATION_DIR', 'CLOUDCLI_SANDBOX_DAEMON_TOKEN'] as const;

/** Runs a test against a fresh SQLite file so nothing leaks between tests. */
export async function withIsolatedDatabase(runTest: (tempDirectory: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  // realpath: macOS tmp lives behind the /var -> /private/var symlink.
  const tempDirectory = fs.realpathSync(await mkdtemp(path.join(os.tmpdir(), 'iso-')));

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

/** Sets (or, with `null`, clears) the isolation env for one test and restores it afterwards. */
export async function withIsolationEnv(
  values: Partial<Record<(typeof ISOLATION_ENV)[number], string>> | null,
  runTest: () => void | Promise<void>,
): Promise<void> {
  const previous = Object.fromEntries(ISOLATION_ENV.map((key) => [key, process.env[key]]));
  for (const key of ISOLATION_ENV) {
    const value = values?.[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
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

/** Isolation env pointing at directories under `dir` (created). */
export function isolationEnvFor(dir: string) {
  const env = {
    CLOUDCLI_ISOLATED_ROOT: path.join(dir, 'isolated'),
    CLOUDCLI_ISOLATED_HOMES: path.join(dir, 'homes'),
    CLOUDCLI_ISOLATION_DIR: path.join(dir, 'iso'),
    CLOUDCLI_SANDBOX_DAEMON_TOKEN: 'daemon-token',
  };
  for (const key of ['CLOUDCLI_ISOLATED_ROOT', 'CLOUDCLI_ISOLATED_HOMES', 'CLOUDCLI_ISOLATION_DIR'] as const) {
    fs.mkdirSync(env[key], { recursive: true });
  }
  return env;
}

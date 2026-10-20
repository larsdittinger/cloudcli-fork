// Isolation env + fresh database for provider tests that touch isolated projects (the isolation module's own
// test helpers are internal to it).
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';

const ISOLATION_ENV = ['CLOUDCLI_ISOLATED_ROOT', 'CLOUDCLI_ISOLATED_HOMES', 'CLOUDCLI_ISOLATION_DIR', 'CLOUDCLI_SANDBOX_DAEMON_TOKEN'] as const;
type IsolationEnv = Record<(typeof ISOLATION_ENV)[number], string>;

export async function withIsolatedDatabase(runTest: (dir: string) => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = fs.realpathSync(await mkdtemp(path.join(os.tmpdir(), 'iso-prov-')));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await runTest(dir);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

/** Isolation env pointing at directories under `dir` (created). */
export function isolationEnvFor(dir: string): IsolationEnv {
  const env: IsolationEnv = {
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

/** Sets (or, with `null`, clears) the isolation env for one test and restores it afterwards. */
export async function withIsolationEnv(values: IsolationEnv | null, runTest: () => void | Promise<void>): Promise<void> {
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

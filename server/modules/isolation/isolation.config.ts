// Where isolated projects live and how the app reaches the sandbox daemon. Read from env on every call
// (deploy sets it; tests change it), never cached.
import path from 'node:path';

export type IsolationConfig = {
  /** False when the instance has no sandbox: isolated runs then fail closed and no isolated copy is offered. */
  available: boolean;
  reason?: string;
  /** Parent of every isolated project directory (`/isolated` in docker). */
  isolatedRoot: string;
  /** Parent of every isolated project's home (`/isolated-homes` in docker). */
  isolatedHomes: string;
  /** Shared with the sandbox: daemon.sock, main.sock and daemon state. */
  isolationDir: string;
  daemonToken: string;
};

const REQUIRED = [
  ['CLOUDCLI_ISOLATED_ROOT', 'isolatedRoot'],
  ['CLOUDCLI_ISOLATED_HOMES', 'isolatedHomes'],
  ['CLOUDCLI_ISOLATION_DIR', 'isolationDir'],
  ['CLOUDCLI_SANDBOX_DAEMON_TOKEN', 'daemonToken'],
] as const;

export function isolationConfig(env: NodeJS.ProcessEnv = process.env): IsolationConfig {
  const read = (key: string) => (env[key] ?? '').trim();
  const missing = REQUIRED.filter(([key]) => !read(key)).map(([key]) => key);
  const absolute = (key: string) => (read(key) ? path.resolve(read(key)) : '');
  const config: IsolationConfig = {
    available: missing.length === 0,
    isolatedRoot: absolute('CLOUDCLI_ISOLATED_ROOT'),
    isolatedHomes: absolute('CLOUDCLI_ISOLATED_HOMES'),
    isolationDir: absolute('CLOUDCLI_ISOLATION_DIR'),
    daemonToken: read('CLOUDCLI_SANDBOX_DAEMON_TOKEN'),
  };
  if (missing.length) {
    config.reason = `Isolation is not set up on this instance (missing ${missing.join(', ')}).`;
  }
  return config;
}

export const daemonSocketPath = (config: IsolationConfig = isolationConfig()) => path.join(config.isolationDir, 'daemon.sock');
export const mainSocketPath = (config: IsolationConfig = isolationConfig()) => path.join(config.isolationDir, 'main.sock');

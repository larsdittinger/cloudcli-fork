// Sandbox daemon: HTTP on a unix socket, upgraded to a framed duplex stream per process.
// Node builtins only: runs standalone in the sandbox image.
import { type ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { hostProcess, killGroup, parseSpawnRequest, type ProcessHostOptions } from './process-host.js';

export type DaemonOptions = {
  token: string;
  isolationDir: string;
  mainGid?: number;
  isolatedRoot?: string;
  isolatedHomes?: string;
  dev?: boolean;
  claudeBin?: string;
  /** Override socket path (tests); defaults to <isolationDir>/daemon.sock. */
  socketPath?: string;
};

export type RunningDaemon = { socketPath: string; close: () => Promise<void> };

function tokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  if (!options.token) throw new Error('SANDBOX_DAEMON_TOKEN is required');
  const dev = Boolean(options.dev);
  if (!dev && (options.mainGid === undefined || !Number.isInteger(options.mainGid))) {
    throw new Error('CLOUDCLI_MAIN_GID is required outside SANDBOX_DEV (socket group would be root)');
  }
  const socketPath = options.socketPath ?? path.join(options.isolationDir, 'daemon.sock');
  const live = new Set<ChildProcess>();
  const hostOptions: ProcessHostOptions = {
    dev,
    live,
    claudeBin: options.claudeBin ?? process.env.CLAUDE_BIN ?? 'claude',
    gidFor: (uid) => uid,
  };

  process.umask(0o007);
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  fs.rmSync(socketPath, { force: true });

  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    const status = tokenMatches(req.headers.authorization, options.token) ? 404 : 401;
    res.writeHead(status).end();
  });

  server.on('upgrade', (req, duplex) => {
    const socket = duplex as import('node:net').Socket;
    const reject = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (!tokenMatches(req.headers.authorization, options.token)) return reject(401, 'Unauthorized');
    if (req.method !== 'POST' || req.url !== '/v1/spawn') return reject(404, 'Not Found');
    let spawnRequest;
    try {
      const header = req.headers['x-spawn'];
      if (typeof header !== 'string') throw new Error('missing X-Spawn');
      spawnRequest = parseSpawnRequest(JSON.parse(Buffer.from(header, 'base64').toString('utf8')));
    } catch {
      return reject(400, 'Bad Request');
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: cloudcli-sandbox\r\n\r\n');
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    hostProcess(socket, spawnRequest, hostOptions);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  fs.chmodSync(socketPath, 0o660);
  if (!dev && options.mainGid !== undefined) {
    fs.chownSync(socketPath, process.getuid?.() ?? 0, options.mainGid);
  }

  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        // Synchronous SIGKILL of every live group: must happen even if the process exits right after.
        for (const child of live) killGroup(child, 'SIGKILL');
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const gid = process.env.CLOUDCLI_MAIN_GID;
  startDaemon({
    token: process.env.SANDBOX_DAEMON_TOKEN ?? '',
    isolationDir: process.env.ISOLATION_DIR ?? '/cloudcli-isolation',
    mainGid: gid ? Number(gid) : undefined, // validated in startDaemon
    isolatedRoot: process.env.ISOLATED_ROOT,
    isolatedHomes: process.env.ISOLATED_HOMES,
    dev: process.env.SANDBOX_DEV === '1',
  }).then(
    (daemon) => {
      console.log(`sandbox daemon listening on ${daemon.socketPath}`);
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.once(signal, () => {
          void daemon.close().finally(() => process.exit(0));
        });
      }
    },
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}

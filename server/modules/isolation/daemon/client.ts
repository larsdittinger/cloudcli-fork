// Minimal client for the sandbox daemon (tests now, the real daemonClient builds on it in Task 5).
import http from 'node:http';
import type { Duplex } from 'node:stream';

import type { SpawnRequest } from './process-host.js';

export class DaemonRejectedError extends Error {
  constructor(public statusCode: number) {
    super(`Sandbox daemon rejected the request: ${statusCode}`);
  }
}

export function connectSpawn(socketPath: string, token: string, request: SpawnRequest): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      method: 'POST',
      path: '/v1/spawn',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'cloudcli-sandbox',
        Authorization: `Bearer ${token}`,
        'X-Spawn': Buffer.from(JSON.stringify(request)).toString('base64'),
      },
    });
    req.on('upgrade', (_res, socket, head) => {
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    req.on('response', (res) => {
      res.resume();
      reject(new DaemonRejectedError(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

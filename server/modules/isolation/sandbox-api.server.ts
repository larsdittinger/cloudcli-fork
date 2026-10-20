// main.sock: the only part of the app the sandbox can reach (through the daemon's 127.0.0.1:7701 forward).
// A separate Express app on a unix socket, never the public one: Claude API proxy and the two MCP bridges,
// each only with a run token. Everything else is 404.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import { createClaudeProxy } from '@/modules/isolation/claude-proxy.js';
import { runTokens, type RunTokenInfo } from '@/modules/isolation/run-tokens.js';

export type SandboxMcpKind = 'channels' | 'tasks';

/** What a request on main.sock carries after the run-token check; MCP routers scope everything by it. */
export type SandboxApiRequest = Request & { isolationRun?: RunTokenInfo; isolationRunToken?: string };

const MCP_MOUNTS: Record<SandboxMcpKind, string> = {
  channels: '/api/channels-mcp',
  tasks: '/api/tasks-mcp',
};

const mcpRouters = new Map<SandboxMcpKind, RequestHandler>();

/**
 * Plugs the run-token aware MCP router of Channels / Tasks into main.sock. Requests reach it only after the
 * run-token check, with `req.isolationRun` set; the global MCP token is not accepted here.
 */
export function registerSandboxMcpRouter(kind: SandboxMcpKind, router: RequestHandler): void {
  mcpRouters.set(kind, router);
}

function readBearer(header: unknown): string {
  if (typeof header !== 'string') return '';
  return /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1] ?? '';
}

export function requireRunToken(resolve: (token: string) => RunTokenInfo | null = runTokens.resolve): RequestHandler {
  return (req, res, next) => {
    const token = readBearer(req.headers.authorization);
    const run = token ? resolve(token) : null;
    if (!run) {
      res.status(401).json({ success: false, error: 'Invalid or expired run token.' });
      return;
    }
    (req as SandboxApiRequest).isolationRun = run;
    (req as SandboxApiRequest).isolationRunToken = token;
    next();
  };
}

export type SandboxApiOptions = {
  claudeProxy?: RequestHandler;
  resolveRunToken?: (token: string) => RunTokenInfo | null;
};

export function createSandboxApiApp(options: SandboxApiOptions = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  // No body parser here: the proxy streams the raw request through.
  app.use('/anthropic', options.claudeProxy ?? createClaudeProxy({ resolveRunToken: options.resolveRunToken }));

  for (const [kind, mount] of Object.entries(MCP_MOUNTS) as Array<[SandboxMcpKind, string]>) {
    app.use(
      mount,
      (req, res, next) => (req.method === 'POST' ? next() : res.status(404).json({ success: false, error: 'Not Found' })),
      requireRunToken(options.resolveRunToken),
      express.json({ limit: '50mb' }),
      (req, res, next) => {
        const router = mcpRouters.get(kind);
        if (!router) {
          res.status(404).json({ success: false, error: 'Not available to isolated agents.' });
          return;
        }
        router(req, res, next);
      },
    );
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ success: false, error: 'Not Found' });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { statusCode?: number; status?: number })?.statusCode ?? (error as { status?: number })?.status ?? 500;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      error: status >= 500 ? 'Internal error' : (error as Error)?.message ?? 'Error',
    });
  });
  return app;
}

export type SandboxApiServer = { socketPath: string; close: () => Promise<void> };

/** Listens on `socketPath` only (mode 0660), replacing a stale socket file left by a crash. */
export async function startSandboxApiServer(socketPath: string, app: express.Express = createSandboxApiApp()): Promise<SandboxApiServer> {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  fs.rmSync(socketPath, { force: true });
  const server = http.createServer(app);
  // Streams (SSE) can idle for long; the CLI has its own timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  const listening = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve());
  });
  // The socket is bound synchronously inside listen(): the narrow umask only covers that bind, so the
  // socket never exists with a wider mode and nothing else the process creates is affected.
  const previousUmask = process.umask(0o117);
  try {
    server.listen(socketPath);
  } finally {
    process.umask(previousUmask);
  }
  await listening;
  fs.chmodSync(socketPath, 0o660);
  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          fs.rmSync(socketPath, { force: true });
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

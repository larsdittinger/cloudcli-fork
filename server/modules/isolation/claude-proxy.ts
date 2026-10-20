// Claude API proxy for sandboxed agents (main.sock `/anthropic/*`). The Claude CLI in the sandbox runs with
// ANTHROPIC_BASE_URL pointing here and its run token as CLAUDE_CODE_OAUTH_TOKEN; the proxy checks the run token
// and swaps it for the instance's Claude token, so no Claude login ever enters the sandbox.
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import type { Request, RequestHandler, Response } from 'express';

import { appConfigDb } from '@/modules/database/index.js';
import { runTokens, type RunTokenInfo } from '@/modules/isolation/run-tokens.js';

/** app_config key of the long-lived `claude setup-token` (`./cloudcli <instance> sandbox-token`). */
export const ISOLATION_CLAUDE_TOKEN_KEY = 'isolation_claude_token';

export const CLAUDE_LOGIN_MISSING = 'Izolovaný agent nemá přihlášení Claude: spusťte ./cloudcli <instance> sandbox-token';

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
const OAUTH_BETA = 'oauth-2025-04-20';

/**
 * Only what the CLI needs to talk to the model. Anything else (account and OAuth endpoints, e.g. creating an
 * API key) would let an agent act as the owner's Claude account.
 */
const ALLOWED_PATH = /^\/(v1\/.+|api\/hello)$/;

const DROP_REQUEST_HEADERS = new Set([
  'host', 'authorization', 'x-api-key', 'cookie', 'connection', 'keep-alive', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'forwarded', 'x-forwarded-for',
  'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
]);
const DROP_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'proxy-authenticate', 'trailer', 'upgrade', 'set-cookie']);

export type ClaudeProxyOptions = {
  /** Upstream base URL; tests point it at a local server. */
  upstreamUrl?: string;
  resolveRunToken?: (token: string) => RunTokenInfo | null;
  /** The setup-token; defaults to app_config.isolation_claude_token. */
  storedToken?: () => string | null;
  /** Fallback login of the app itself; defaults to ~/.claude/.credentials.json. */
  credentialsPath?: string;
  now?: () => number;
};

function anthropicError(res: Response, status: number, type: string, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(status).json({ type: 'error', error: { type, message } });
}

function readBearer(header: unknown): string {
  if (typeof header !== 'string') return '';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? '';
}

async function credentialsAccessToken(credentialsPath: string, now: number): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath, 'utf8')) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } };
    const accessToken = parsed?.claudeAiOauth?.accessToken;
    const expiresAt = parsed?.claudeAiOauth?.expiresAt;
    if (typeof accessToken !== 'string' || !accessToken) return null;
    // A minute of margin: a token that dies mid-request is as good as none.
    if (typeof expiresAt === 'number' && expiresAt <= now + 60_000) return null;
    return accessToken;
  } catch {
    return null;
  }
}

/** The Claude token the proxy forwards with: setup-token, else the app's own still-valid login, else null. */
export async function resolveClaudeToken(options: Pick<ClaudeProxyOptions, 'storedToken' | 'credentialsPath' | 'now'> = {}): Promise<{ token: string; source: 'setup-token' | 'credentials' } | null> {
  const stored = (options.storedToken ?? (() => appConfigDb.get(ISOLATION_CLAUDE_TOKEN_KEY)))()?.trim();
  if (stored) return { token: stored, source: 'setup-token' };
  const credentialsPath = options.credentialsPath ?? path.join(os.homedir(), '.claude', '.credentials.json');
  const access = await credentialsAccessToken(credentialsPath, (options.now ?? Date.now)());
  return access ? { token: access, source: 'credentials' } : null;
}

function withOauthBeta(value: string | string[] | undefined): string {
  const parts = (Array.isArray(value) ? value.join(',') : value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.includes(OAUTH_BETA)) parts.push(OAUTH_BETA);
  return parts.join(',');
}

export function createClaudeProxy(options: ClaudeProxyOptions = {}): RequestHandler {
  const upstream = new URL(options.upstreamUrl ?? DEFAULT_UPSTREAM);
  const transport = upstream.protocol === 'https:' ? https : http;
  const resolveRunToken = options.resolveRunToken ?? runTokens.resolve;

  return (req: Request, res: Response) => {
    void (async () => {
      const run = resolveRunToken(readBearer(req.headers.authorization));
      if (!run) return anthropicError(res, 401, 'authentication_error', 'CloudCLI sandbox: invalid or expired run token.');
      // Schedule scripts run without a Claude login; their token is for the MCP bridges only.
      if (run.purpose === 'exec') return anthropicError(res, 403, 'permission_error', 'CloudCLI sandbox: scripts of isolated projects cannot use the Claude API.');

      // req.url is relative to the /anthropic mount. Resolve dot segments before checking the path.
      const target = new URL(req.url || '/', 'http://proxy');
      if (!ALLOWED_PATH.test(target.pathname)) {
        return anthropicError(res, 403, 'permission_error', `CloudCLI sandbox: ${target.pathname} is not available to isolated agents.`);
      }

      const claude = await resolveClaudeToken(options);
      if (!claude) return anthropicError(res, 401, 'authentication_error', CLAUDE_LOGIN_MISSING);

      const headers: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined && !DROP_REQUEST_HEADERS.has(name)) headers[name] = value;
      }
      headers.host = upstream.host;
      headers.authorization = `Bearer ${claude.token}`;
      headers['anthropic-beta'] = withOauthBeta(req.headers['anthropic-beta']);

      const basePath = upstream.pathname.replace(/\/+$/, '');
      const upstreamReq = transport.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || undefined,
          method: req.method,
          path: `${basePath}${target.pathname}${target.search}`,
          headers,
        },
        (upstreamRes) => {
          const responseHeaders: http.OutgoingHttpHeaders = {};
          for (const [name, value] of Object.entries(upstreamRes.headers)) {
            if (value !== undefined && !DROP_RESPONSE_HEADERS.has(name)) responseHeaders[name] = value;
          }
          res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
          res.flushHeaders();
          // Piped chunk by chunk: SSE events reach the CLI as Anthropic sends them.
          upstreamRes.pipe(res);
          upstreamRes.on('error', () => res.destroy());
        },
      );
      upstreamReq.on('error', (error) => {
        anthropicError(res, 502, 'api_error', `CloudCLI sandbox: Claude API unreachable (${error.message}).`);
      });
      res.on('close', () => {
        if (!res.writableFinished) upstreamReq.destroy();
      });
      req.pipe(upstreamReq);
    })().catch((error: unknown) => {
      anthropicError(res, 500, 'api_error', `CloudCLI sandbox proxy failed: ${(error as Error).message}`);
    });
  };
}

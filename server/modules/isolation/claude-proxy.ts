// Claude API proxy for sandboxed agents (main.sock `/anthropic/*`). The Claude CLI in the sandbox runs with
// ANTHROPIC_BASE_URL pointing here and its run token as CLAUDE_CODE_OAUTH_TOKEN; the proxy checks the run token
// and swaps it for the instance's Claude token, so no Claude login ever enters the sandbox.
import { createHash } from 'node:crypto';
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

export const CLAUDE_LOGIN_MISSING = 'Izolovaný agent nemá přihlášení Claude: nastavte ho v Settings → Izolace (nebo ./cloudcli <instance> sandbox-token)';

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
const OAUTH_BETA = 'oauth-2025-04-20';

/**
 * Only what the CLI needs to talk to the model. Anything else would let an agent act as the owner's Claude account
 * — account and OAuth endpoints (creating an API key), and other /v1 APIs such as /v1/mcp_servers (the owner's
 * claude.ai connectors), /v1/sessions or /v1/files. Checked before any token is chosen, so the credentials
 * fallback (a full-scope OAuth login) reaches exactly these paths too. The query string is not part of the check.
 */
const ALLOWED_PATHS = [/^\/v1\/messages(\/count_tokens)?$/, /^\/v1\/models(\/[^/]+)?$/, /^\/api\/hello$/];
const MAX_LOGGED_PATHS = 200;
const MAX_ERROR_BODY_BYTES = 4096;
const MAX_ERROR_MESSAGE_LENGTH = 300;

export const isAllowedClaudePath = (pathname: string) => ALLOWED_PATHS.some((pattern) => pattern.test(pathname));

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
  /** Called once per refused path (default: a warning in the log), so E2E shows what the CLI would need. */
  onRefused?: (pathname: string) => void;
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

const defaultCredentialsPath = () => path.join(os.homedir(), '.claude', '.credentials.json');

/** The app's own Claude login (`~/.claude/.credentials.json`), or null when there is none or it cannot be read. */
export async function readCredentialsLogin(credentialsPath = defaultCredentialsPath()): Promise<{ accessToken: string; expiresAt: number | null } | null> {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath, 'utf8')) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } };
    const accessToken = parsed?.claudeAiOauth?.accessToken;
    const expiresAt = parsed?.claudeAiOauth?.expiresAt;
    if (typeof accessToken !== 'string' || !accessToken) return null;
    return { accessToken, expiresAt: typeof expiresAt === 'number' ? expiresAt : null };
  } catch {
    return null;
  }
}

async function credentialsAccessToken(credentialsPath: string, now: number): Promise<string | null> {
  const login = await readCredentialsLogin(credentialsPath);
  if (!login) return null;
  // A minute of margin: a token that dies mid-request is as good as none.
  if (login.expiresAt !== null && login.expiresAt <= now + 60_000) return null;
  return login.accessToken;
}

/** Identifies a Claude token in records kept about it (last check, proxy health) without keeping the token itself. */
export const tokenFingerprint = (token: string): string => createHash('sha256').update(token).digest('hex').slice(0, 16);

/** Removes anything that looks like an Anthropic credential from a text shown to the owner. */
export const redactClaudeTokens = (text: string): string => text.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-…');

export type ClaudeUpstreamHealth = {
  okAt?: string;
  error?: { at: string; status: number | null; message: string };
};

let upstreamRecord: { fingerprint: string; health: ClaudeUpstreamHealth } = { fingerprint: '', health: {} };

function upstreamHealthOf(token: string): ClaudeUpstreamHealth {
  const fingerprint = tokenFingerprint(token);
  // One record: the proxy forwards with one token at a time, and a new token starts clean.
  if (upstreamRecord.fingerprint !== fingerprint) upstreamRecord = { fingerprint, health: {} };
  return upstreamRecord.health;
}

/**
 * What the proxy last saw from Anthropic with a given token — kept in memory only. Used by the Claude login
 * settings (claude-login.ts) to tell the owner the token stopped working (401/403) before an agent run fails.
 */
export const claudeUpstreamHealth = {
  recordOk(token: string): void {
    upstreamHealthOf(token).okAt = new Date().toISOString();
  },
  recordError(token: string, status: number | null, message: string): void {
    const text = redactClaudeTokens(message).replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_MESSAGE_LENGTH);
    upstreamHealthOf(token).error = { at: new Date().toISOString(), status, message: text || `HTTP ${status}` };
  },
  /** The record of `token`, empty when the proxy has not used it since the start (or since another token). */
  forToken(token: string): ClaudeUpstreamHealth {
    return upstreamRecord.fingerprint === tokenFingerprint(token) ? { ...upstreamRecord.health } : {};
  },
  reset(): void {
    upstreamRecord = { fingerprint: '', health: {} };
  },
};

/** `error.message` of an Anthropic error body, else the start of the body. */
function upstreamErrorMessage(body: string): string {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } })?.error?.message;
    if (typeof message === 'string' && message.trim()) return message;
  } catch {
    // Not JSON (cut at MAX_ERROR_BODY_BYTES, or an HTML error page).
  }
  return body;
}

/** The Claude token the proxy forwards with: setup-token, else the app's own still-valid login, else null. */
export async function resolveClaudeToken(options: Pick<ClaudeProxyOptions, 'storedToken' | 'credentialsPath' | 'now'> = {}): Promise<{ token: string; source: 'setup-token' | 'credentials' } | null> {
  const stored = (options.storedToken ?? (() => appConfigDb.get(ISOLATION_CLAUDE_TOKEN_KEY)))()?.trim();
  if (stored) return { token: stored, source: 'setup-token' };
  const credentialsPath = options.credentialsPath ?? defaultCredentialsPath();
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
  const onRefused = options.onRefused ?? ((pathname: string) => console.warn(`[Isolation] Claude proxy refused ${pathname} (not an inference path)`));
  const logged = new Set<string>();
  const refusedOnce = (pathname: string) => {
    // Bounded: the agent chooses the paths.
    if (logged.has(pathname) || logged.size >= MAX_LOGGED_PATHS) return;
    logged.add(pathname);
    onRefused(pathname);
  };

  return (req: Request, res: Response) => {
    void (async () => {
      const run = resolveRunToken(readBearer(req.headers.authorization));
      if (!run) return anthropicError(res, 401, 'authentication_error', 'CloudCLI sandbox: invalid or expired run token.');
      // Schedule scripts run without a Claude login; their token is for the MCP bridges only.
      if (run.purpose === 'exec') return anthropicError(res, 403, 'permission_error', 'CloudCLI sandbox: scripts of isolated projects cannot use the Claude API.');

      // req.url is relative to the /anthropic mount. Resolve dot segments before checking the path.
      const target = new URL(req.url || '/', 'http://proxy');
      if (!isAllowedClaudePath(target.pathname)) {
        refusedOnce(target.pathname.slice(0, 200));
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
          const status = upstreamRes.statusCode ?? 502;
          if (status < 400) {
            claudeUpstreamHealth.recordOk(claude.token);
          } else {
            // Read alongside the pipe (the CLI still gets the whole answer): enough for Anthropic's error JSON.
            const parts: Buffer[] = [];
            let size = 0;
            let recorded = false;
            const record = () => {
              if (recorded) return;
              recorded = true;
              claudeUpstreamHealth.recordError(claude.token, status, upstreamErrorMessage(Buffer.concat(parts).toString('utf8')));
            };
            upstreamRes.on('data', (chunk: Buffer) => {
              if (size >= MAX_ERROR_BODY_BYTES) return;
              parts.push(chunk.subarray(0, MAX_ERROR_BODY_BYTES - size));
              size += chunk.length;
            });
            upstreamRes.on('end', record);
            upstreamRes.on('close', record);
          }
          res.writeHead(status, responseHeaders);
          res.flushHeaders();
          // Piped chunk by chunk: SSE events reach the CLI as Anthropic sends them.
          upstreamRes.pipe(res);
          upstreamRes.on('error', () => res.destroy());
        },
      );
      let clientGone = false;
      upstreamReq.on('error', (error) => {
        // Not Anthropic's fault when the CLI hung up first (Stop) and the request was cut here.
        if (!clientGone) claudeUpstreamHealth.recordError(claude.token, null, `Claude API unreachable: ${error.message}`);
        anthropicError(res, 502, 'api_error', `CloudCLI sandbox: Claude API unreachable (${error.message}).`);
      });
      res.on('close', () => {
        if (res.writableFinished) return;
        clientGone = true;
        upstreamReq.destroy();
      });
      req.pipe(upstreamReq);
    })().catch((error: unknown) => {
      anthropicError(res, 500, 'api_error', `CloudCLI sandbox proxy failed: ${(error as Error).message}`);
    });
  };
}

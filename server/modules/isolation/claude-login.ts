// Claude login of isolated agents (Settings → Isolation): the long-lived `claude setup-token` the Claude proxy
// forwards with, its verification against Anthropic, and what the owner sees about it. The token itself never
// leaves the server: responses carry only its last four characters.
import { appConfigDb } from '@/modules/database/index.js';
import {
  claudeUpstreamHealth,
  ISOLATION_CLAUDE_TOKEN_KEY,
  readCredentialsLogin,
  redactClaudeTokens,
  resolveClaudeToken,
  tokenFingerprint,
  type ClaudeUpstreamHealth,
} from '@/modules/isolation/claude-proxy.js';
import { AppError } from '@/shared/utils.js';

/** When the token was saved from Settings (ISO). Missing for a token written by the hub (`./cloudcli … sandbox-token`). */
export const ISOLATION_CLAUDE_TOKEN_SET_AT_KEY = 'isolation_claude_token_set_at';
/** JSON of the last verification ({ ok, at, status?, error?, unverified?, fingerprint }), of one token only. */
const LAST_CHECK_KEY = 'isolation_claude_last_check';

const SETUP_TOKEN_PATTERN = /sk-ant-oat01-[A-Za-z0-9_-]+/g;
// Same floor as the hub script: real tokens have ~108 characters, a shorter one was cut or wrapped while copying.
const MIN_TOKEN_LENGTH = 60;
const VERIFY_URL = 'https://api.anthropic.com/v1/messages/count_tokens';
const VERIFY_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_LENGTH = 300;

/**
 * The single setup-token in `text` — the whole output of `claude setup-token` may be pasted, the token is found
 * by its prefix. Throws (400) for no token, two different tokens or a token too short to be whole.
 */
export function extractSetupToken(text: string): string {
  const tokens = [...new Set(text.match(SETUP_TOKEN_PATTERN) ?? [])];
  if (tokens.length === 0) {
    throw new AppError('No sk-ant-oat01-… token found. Paste the output of `claude setup-token`.', { code: 'NO_TOKEN', statusCode: 400 });
  }
  if (tokens.length > 1) {
    throw new AppError('The text contains more than one different token. Paste just one.', { code: 'MULTIPLE_TOKENS', statusCode: 400 });
  }
  if (tokens[0].length < MIN_TOKEN_LENGTH) {
    throw new AppError(`The token is too short (${tokens[0].length} characters): it was probably cut or wrapped when copying.`, { code: 'TOKEN_TOO_SHORT', statusCode: 400 });
  }
  return tokens[0];
}

type VerifyResult = { result: 'ok' | 'rejected' | 'unverified'; status?: number; message?: string };

const shorten = (text: string) => redactClaudeTokens(text).replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_LENGTH);

/**
 * Asks Anthropic whether `token` works: counting tokens of a one-word message is free and runs on the same
 * Messages API (and OAuth scope) the agents use. 2xx = ok, 401/403 = rejected; anything else (network,
 * overload, rate limit) says nothing about the token = unverified.
 */
export async function verifyClaudeToken(token: string, options: { fetchImpl?: typeof fetch } = {}): Promise<VerifyResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(VERIFY_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'ok' }] }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (error) {
    return { result: 'unverified', message: shorten(`Anthropic is unreachable: ${(error as Error).message}`) };
  }
  if (response.ok) return { result: 'ok', status: response.status };
  const body = await response.text().catch(() => '');
  let message = body;
  try {
    const parsed = (JSON.parse(body) as { error?: { message?: unknown } })?.error?.message;
    if (typeof parsed === 'string' && parsed.trim()) message = parsed;
  } catch {
    // Not JSON: keep the start of the body.
  }
  return {
    result: response.status === 401 || response.status === 403 ? 'rejected' : 'unverified',
    status: response.status,
    message: shorten(message) || `HTTP ${response.status}`,
  };
}

type LastCheck = { ok: boolean; at: string; status?: number; error?: string; unverified?: boolean };

/** What Settings → Isolation shows about the Claude login of isolated agents. Never the token. */
type ClaudeLoginState = {
  source: 'setup-token' | 'credentials' | 'missing';
  tokenSetAt: string | null;
  tokenLast4: string | null;
  credentialsExpiresAt: string | null;
  lastCheck: LastCheck | null;
  lastUpstream: ClaudeUpstreamHealth;
};

function storedToken(): string | null {
  return appConfigDb.get(ISOLATION_CLAUDE_TOKEN_KEY)?.trim() || null;
}

function saveLastCheck(token: string, verified: VerifyResult): void {
  const check: LastCheck & { fingerprint: string } = {
    ok: verified.result === 'ok',
    at: new Date().toISOString(),
    fingerprint: tokenFingerprint(token),
  };
  if (verified.status !== undefined) check.status = verified.status;
  if (verified.result !== 'ok') check.error = verified.message ?? 'Unknown error';
  if (verified.result === 'unverified') check.unverified = true;
  appConfigDb.set(LAST_CHECK_KEY, JSON.stringify(check));
}

/** The stored check, only when it was made with `token` (the hub may have replaced the token since). */
function lastCheckFor(token: string | null): LastCheck | null {
  if (!token) return null;
  try {
    const { fingerprint, ...check } = JSON.parse(appConfigDb.get(LAST_CHECK_KEY) ?? 'null') as LastCheck & { fingerprint?: string };
    return fingerprint === tokenFingerprint(token) ? check : null;
  } catch {
    return null;
  }
}

/** Used by the isolation admin routes (`/api/isolation/claude-login`). */
export const claudeLoginService = {
  async get(): Promise<ClaudeLoginState> {
    const [current, credentials] = await Promise.all([resolveClaudeToken().catch(() => null), readCredentialsLogin()]);
    const stored = storedToken();
    const setAt = stored ? appConfigDb.get(ISOLATION_CLAUDE_TOKEN_SET_AT_KEY) : null;
    return {
      source: current?.source ?? 'missing',
      tokenSetAt: setAt || null,
      tokenLast4: stored ? stored.slice(-4) : null,
      credentialsExpiresAt: credentials?.expiresAt ? new Date(credentials.expiresAt).toISOString() : null,
      lastCheck: lastCheckFor(current?.token ?? null),
      lastUpstream: current ? claudeUpstreamHealth.forToken(current.token) : {},
    };
  },

  /**
   * Verifies the token in `text` and saves it. Refused by Anthropic (401/403) = never saved; Anthropic not
   * answering = saved only with `force` (the owner confirmed saving it unverified).
   */
  async save(text: string, force: boolean): Promise<ClaudeLoginState> {
    const token = extractSetupToken(text);
    const verified = await verifyClaudeToken(token);
    if (verified.result === 'rejected') {
      throw new AppError(`Anthropic refused the token (HTTP ${verified.status}): ${verified.message}`, {
        code: 'TOKEN_REJECTED',
        statusCode: 400,
        details: { status: verified.status, message: verified.message },
      });
    }
    if (verified.result === 'unverified' && !force) {
      throw new AppError(`The token could not be verified: ${verified.message}`, {
        code: 'VERIFY_UNAVAILABLE',
        statusCode: 502,
        details: { status: verified.status ?? null, message: verified.message },
      });
    }
    appConfigDb.set(ISOLATION_CLAUDE_TOKEN_KEY, token);
    appConfigDb.set(ISOLATION_CLAUDE_TOKEN_SET_AT_KEY, new Date().toISOString());
    saveLastCheck(token, verified);
    return this.get();
  },

  /** Verifies the login the proxy uses right now and keeps the result. */
  async check(): Promise<ClaudeLoginState> {
    const current = await resolveClaudeToken();
    if (!current) throw new AppError('Isolated agents have no Claude login to check.', { code: 'NO_CLAUDE_LOGIN', statusCode: 409 });
    saveLastCheck(current.token, await verifyClaudeToken(current.token));
    return this.get();
  },

  /** Removes the setup-token; the proxy falls back to the app's own login (until it expires). */
  async remove(): Promise<ClaudeLoginState> {
    // app_config has no delete; an empty value reads as "no token" everywhere (resolveClaudeToken trims).
    appConfigDb.set(ISOLATION_CLAUDE_TOKEN_KEY, '');
    appConfigDb.set(ISOLATION_CLAUDE_TOKEN_SET_AT_KEY, '');
    appConfigDb.set(LAST_CHECK_KEY, '');
    return this.get();
  },
};

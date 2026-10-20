import { useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';

/** `GET /api/isolation/claude-login`: how isolated agents reach Claude. Carries the token's last four characters only. */
export type ClaudeLoginState = {
  source: 'setup-token' | 'credentials' | 'missing';
  /** null for a token written by the hub (`./cloudcli … sandbox-token`). */
  tokenSetAt: string | null;
  tokenLast4: string | null;
  credentialsExpiresAt: string | null;
  lastCheck: { ok: boolean; at: string; status?: number; error?: string; unverified?: boolean } | null;
  lastUpstream: { okAt?: string; error?: { at: string; status: number | null; message: string } };
};

const isAuthStatus = (status: number | null | undefined) => status === 401 || status === 403;

/** The proxy's last answer from Anthropic was a 401/403 (and nothing has worked since). */
function upstreamAuthFailed(state: ClaudeLoginState): boolean {
  const { okAt, error } = state.lastUpstream;
  return Boolean(error && isAuthStatus(error.status) && (!okAt || Date.parse(error.at) >= Date.parse(okAt)));
}

/** Isolated agents lack a lasting Claude login: no setup-token, or Anthropic refuses the one they have. */
export function needsClaudeLogin(state: ClaudeLoginState): boolean {
  if (state.source !== 'setup-token') return true;
  if (state.lastCheck && !state.lastCheck.ok && isAuthStatus(state.lastCheck.status)) return true;
  return upstreamAuthFailed(state);
}

/** The Claude login of isolated agents while `enabled`; `setState` takes the state a save/check/remove answered with. */
export function useClaudeLogin(enabled: boolean) {
  // The server's answer; null until it arrives or when it cannot be read (not an admin, offline).
  const [state, setState] = useState<ClaudeLoginState | null>(null);
  // Why the state could not be loaded, shown instead of it.
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    void Promise.resolve()
      .then(() => api.isolation.claudeLogin())
      .then((response) => readApiJson<{ data: ClaudeLoginState }>(response))
      .then((body) => { if (!cancelled) { setState(body.data); setLoadError(null); } })
      .catch((error: unknown) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [enabled]);

  return { state, setState, loadError };
}

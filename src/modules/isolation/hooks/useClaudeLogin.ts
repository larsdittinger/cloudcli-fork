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

/**
 * Isolated agents lack a lasting Claude login: no setup-token, or the newest telling signal about the token is a
 * refusal. Signals are the last check (refused with 401/403 = bad, ok = good; an unverifiable check says nothing)
 * and the proxy's last success / last 401-403 error (other errors — overload, rate limit — say nothing). A later
 * success clears an older failure and vice versa.
 */
export function needsClaudeLogin(state: ClaudeLoginState): boolean {
  if (state.source !== 'setup-token') return true;
  const signals: Array<{ at: number; good: boolean }> = [];
  const { lastCheck, lastUpstream } = state;
  if (lastCheck && !lastCheck.unverified && (lastCheck.ok || isAuthStatus(lastCheck.status))) {
    signals.push({ at: Date.parse(lastCheck.at), good: lastCheck.ok });
  }
  if (lastUpstream.okAt) signals.push({ at: Date.parse(lastUpstream.okAt), good: true });
  if (lastUpstream.error && isAuthStatus(lastUpstream.error.status)) signals.push({ at: Date.parse(lastUpstream.error.at), good: false });
  const newest = signals.filter((signal) => Number.isFinite(signal.at)).sort((a, b) => b.at - a.at)[0];
  return newest ? !newest.good : false;
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

import { useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';

export type IsolationStatus = {
  available: boolean;
  reason?: string;
  daemon: { running: boolean; ok: boolean; reason?: string; version?: string; claudeVersion?: string; projects?: number } | null;
  claudeLogin?: string;
  isolatedProjects?: number;
};

export type IsolationTools = { channels: boolean; tasks: boolean };
export type BlockedEntry = { at: string; host: string; port: number; kind: 'connect' | 'http' };
export type SelfCheck = { id: string; ok: boolean; detail: string };
export type LineError = { line: number; message: string };

/** `/api/isolation/status` while `enabled`: the status once it answers, or why it could not be loaded. */
export function useIsolationStatusResult(enabled: boolean): { status: IsolationStatus | null; error: string | null } {
  // The last answer; null until the first one arrives or when the request failed.
  const [status, setStatus] = useState<IsolationStatus | null>(null);
  // Why the status could not be loaded (not an admin, offline, server error); null while loading or loaded.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    void Promise.resolve()
      .then(() => api.isolation.status())
      .then((response) => readApiJson<{ data: IsolationStatus }>(response))
      .then((body) => { if (!cancelled) { setStatus(body.data); setError(null); } })
      .catch((reason: unknown) => { if (!cancelled) { setStatus(null); setError(errorMessage(reason)); } });
    return () => { cancelled = true; };
  }, [enabled]);

  return { status, error };
}

/** `/api/isolation/status` while `enabled`; null until it answers or when it cannot (not an admin, offline). */
export function useIsolationStatus(enabled: boolean): IsolationStatus | null {
  return useIsolationStatusResult(enabled).status;
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const HOSTNAME = /^[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

/**
 * Anthropic's own services (API, MCP proxy of the claude.ai connectors…). The agent's Claude traffic goes through
 * the app's proxy; letting one of these through directly could hand it the owner's claude.ai connectors.
 */
export function isClaudeServiceHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/\.+$/, '');
  return ['anthropic.com', 'claude.ai', 'claude.com'].some((domain) => name === domain || name.endsWith(`.${domain}`));
}

/**
 * The allowlist line that lets a blocked request through, or null when none is safe to offer. The host comes
 * from the agent, so only a plain hostname (with a dot, no wildcard) or an IP with a non-web port qualifies:
 * a bare host for HTTP(S) ports, host:port otherwise.
 */
export function allowlistLineFor(entry: Pick<BlockedEntry, 'host' | 'port' | 'kind'>): string | null {
  const { host, port } = entry;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (isClaudeServiceHost(host)) return null;
  const web = port === 80 || port === 443;
  if (IPV4.test(host)) return web ? null : `${host}:${port}`;
  if (host.includes(':')) return IPV6.test(host) && !web ? `[${host}]:${port}` : null;
  if (!host.includes('.') || host.includes('*') || !HOSTNAME.test(host)) return null;
  return web ? host : `${host}:${port}`;
}

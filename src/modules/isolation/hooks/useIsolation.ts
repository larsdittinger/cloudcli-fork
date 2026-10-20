import { useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';

export type IsolationStatus = {
  available: boolean;
  reason?: string;
  daemon: { running: boolean; ok: boolean; reason?: string; projects?: number } | null;
  claudeLogin?: string;
  isolatedProjects?: number;
};

export type IsolationTools = { channels: boolean; tasks: boolean };
export type BlockedEntry = { at: string; host: string; port: number; kind: 'connect' | 'http' };
export type SelfCheck = { id: string; ok: boolean; detail: string };
export type LineError = { line: number; message: string };

/** `/api/isolation/status` while `enabled`; null until it answers or when it cannot (not an admin, offline). */
export function useIsolationStatus(enabled: boolean): IsolationStatus | null {
  const [status, setStatus] = useState<IsolationStatus | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    void api.isolation.status()
      .then((response) => readApiJson<{ data: IsolationStatus }>(response))
      .then((body) => { if (!cancelled) setStatus(body.data); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [enabled]);

  return status;
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

/** The allowlist line that lets a blocked request through: a bare host for HTTP(S), host:port for anything else. */
export function allowlistLineFor(entry: Pick<BlockedEntry, 'host' | 'port' | 'kind'>): string {
  const isIp = /^[\d.]+$/.test(entry.host) || entry.host.includes(':');
  const web = entry.port === 80 || entry.port === 443;
  if (web && !isIp) return entry.host;
  return `${entry.host.includes(':') ? `[${entry.host}]` : entry.host}:${entry.port}`;
}

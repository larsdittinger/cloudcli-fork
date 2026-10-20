// Allowlist parsing and matching for isolated projects. Node builtins only: also imported by the main server.
import net from 'node:net';
import { domainToASCII } from 'node:url';

export type AllowEntry =
  | { kind: 'domain'; host: string; wildcard: boolean }
  | { kind: 'tcp'; host: string; port: number };

export type AllowlistError = { line: number; message: string };

/** Ports a `domain` entry covers (HTTP/HTTPS through the proxy). */
export const DEFAULT_HTTP_PORTS: readonly number[] = [80, 443];

const LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;

/** Lowercase, drop the trailing dot, IDN to punycode. Returns '' when the host is not valid. */
export function normalizeHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.endsWith('.')) host = host.slice(0, -1);
  if (!host) return '';
  if (net.isIP(host)) return host;
  const ascii = domainToASCII(host);
  if (!ascii || ascii.length > 253) return '';
  return ascii.split('.').every((label) => LABEL.test(label)) ? ascii : '';
}

export function parseAllowlist(lines: string[]): { entries: AllowEntry[]; errors: AllowlistError[] } {
  const entries: AllowEntry[] = [];
  const errors: AllowlistError[] = [];
  lines.forEach((rawLine, index) => {
    const line = index + 1;
    const text = rawLine.trim();
    if (!text || text.startsWith('#')) return;
    const fail = (message: string) => errors.push({ line, message });

    const wildcard = text.startsWith('*.');
    const body = wildcard ? text.slice(2) : text;
    const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(body);
    const colon = bracketed ? -1 : body.lastIndexOf(':');
    const hasPort = Boolean(bracketed) || (colon > 0 && !net.isIP(body));

    if (hasPort) {
      if (wildcard) return fail('Wildcard is not supported for host:port entries');
      const hostPart = bracketed ? bracketed[1] : body.slice(0, colon);
      const portPart = bracketed ? bracketed[2] : body.slice(colon + 1);
      const port = /^\d{1,5}$/.test(portPart) ? Number(portPart) : 0;
      if (port < 1 || port > 65535) return fail(`Invalid port "${portPart}"`);
      const host = normalizeHost(hostPart);
      if (!host) return fail(`Invalid host "${hostPart}"`);
      entries.push({ kind: 'tcp', host, port });
      return;
    }

    const host = normalizeHost(body);
    if (!host) return fail(`Invalid domain "${text}"`);
    if (net.isIP(host)) return fail('Use a name, not an IP address (an IP is only allowed as ip:port)');
    entries.push({ kind: 'domain', host, wildcard });
  });
  return { entries, errors };
}

export function isHttpAllowed(
  entries: AllowEntry[],
  host: string,
  port: number,
  httpPorts: readonly number[] = DEFAULT_HTTP_PORTS,
): boolean {
  if (!httpPorts.includes(port)) return false;
  const target = normalizeHost(host);
  if (!target || net.isIP(target)) return false;
  return entries.some((entry) => {
    if (entry.kind !== 'domain') return false;
    return entry.wildcard ? target.endsWith(`.${entry.host}`) : target === entry.host;
  });
}

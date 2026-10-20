// Firewall for isolated uids: pure rule builder plus production-only appliers. Node builtins only.
import { execFile } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';

export const FIREWALL_CHAIN = 'CLOUDCLI_SANDBOX';
export const MIN_ISOLATED_UID = 20000;
const HOSTS_BEGIN = '# BEGIN cloudcli-sandbox';
const HOSTS_END = '# END cloudcli-sandbox';

export type FirewallProject = { uid: number; tcp: Array<{ ip: string; port: number }> };
export type FirewallOptions = { proxyPort: number; forwardPort: number; family?: 4 | 6 };

/**
 * Input for `iptables-restore --noflush` (or ip6tables-restore): refills CLOUDCLI_SANDBOX from scratch.
 * Per isolated uid: loopback to the forward/proxy ports, its own TCP allowlist IPs, everything else DROP
 * (incl. UDP/53). Root and uids without a project never match an owner rule.
 */
export function buildFirewallRules(projects: FirewallProject[], opts: FirewallOptions): string[] {
  const family = opts.family ?? 4;
  const lines = ['*filter', `:${FIREWALL_CHAIN} - [0:0]`, `-F ${FIREWALL_CHAIN}`];
  for (const project of projects) {
    if (!Number.isInteger(project.uid) || project.uid < MIN_ISOLATED_UID) {
      throw new Error(`Refusing firewall rules for uid ${project.uid} (< ${MIN_ISOLATED_UID})`);
    }
    const owner = `-m owner --uid-owner ${project.uid}`;
    for (const port of [opts.forwardPort, opts.proxyPort]) {
      lines.push(`-A ${FIREWALL_CHAIN} ${owner} -o lo -p tcp --dport ${port} -j ACCEPT`);
    }
    for (const target of project.tcp) {
      if (net.isIP(target.ip) !== family) continue;
      lines.push(`-A ${FIREWALL_CHAIN} ${owner} -d ${target.ip} -p tcp --dport ${target.port} -j ACCEPT`);
    }
    lines.push(`-A ${FIREWALL_CHAIN} ${owner} -j DROP`);
  }
  lines.push('COMMIT');
  return lines;
}

/** Replaces (or appends) the marker block in /etc/hosts content. Empty entries remove the block. */
export function renderHostsFile(existing: string, entries: Array<{ ip: string; host: string }>): string {
  const begin = existing.indexOf(HOSTS_BEGIN);
  const end = existing.indexOf(HOSTS_END);
  let base = existing;
  if (begin >= 0 && end > begin) base = existing.slice(0, begin) + existing.slice(end + HOSTS_END.length).replace(/^\n/, '');
  base = base.replace(/\n*$/, '\n');
  if (entries.length === 0) return base;
  const block = [HOSTS_BEGIN, ...entries.map((e) => `${e.ip} ${e.host}`), HOSTS_END].join('\n');
  return `${base}${block}\n`;
}

export async function resolveHost(host: string): Promise<string[]> {
  if (net.isIP(host)) return [host];
  const results = await dns.lookup(host, { all: true });
  return results.map((r) => r.address);
}

function run(cmd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, (error, stdout, stderr) => {
      if (error) reject(new Error(`${cmd} ${args.join(' ')}: ${stderr || error.message}`.trim()));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** Production applier: ensures chain + OUTPUT jump (idempotent), then refills the chain atomically. */
export async function applyFirewallRules(rules4: string[], rules6: string[]): Promise<void> {
  for (const [bin, rules] of [['iptables', rules4], ['ip6tables', rules6]] as const) {
    await run(bin, ['-N', FIREWALL_CHAIN]).catch(() => undefined); // exists already
    await run(bin, ['-C', 'OUTPUT', '-j', FIREWALL_CHAIN]).catch(() => run(bin, ['-I', 'OUTPUT', '1', '-j', FIREWALL_CHAIN]));
    await run(`${bin}-restore`, ['--noflush'], `${rules.join('\n')}\n`);
    await run(bin, ['-S', FIREWALL_CHAIN]);
  }
}

export function applyHostsFile(entries: Array<{ ip: string; host: string }>, hostsPath = '/etc/hosts'): void {
  const current = fs.existsSync(hostsPath) ? fs.readFileSync(hostsPath, 'utf8') : '';
  const next = renderHostsFile(current, entries);
  if (next === current) return;
  // /etc/hosts is a bind mount in containers: rewrite in place instead of rename.
  fs.writeFileSync(hostsPath, next);
}

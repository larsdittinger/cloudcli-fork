/**
 * Whether an e-mail's sender is who the From line says, by the receiving mail
 * server's SPF/DKIM/DMARC verdict (the topmost `Authentication-Results`).
 *
 * Only an explicit failure counts: no header, or an undecided result
 * (none, neutral, softfail, temperror), leaves the message as it always was. A sender
 * can add `Authentication-Results` lines of their own, but the receiving
 * server puts its own above them, so only the topmost one is read.
 */
export type SenderAuth = 'pass' | 'fail';

function domainOf(value: string): string {
  const at = value.lastIndexOf('@');
  return (at >= 0 ? value.slice(at + 1) : value).trim().replace(/[>;,\s].*$/, '').toLowerCase();
}

/** firma.cz is vouched for by firma.cz or a subdomain of it, and the other way round (relaxed alignment). */
function aligned(domain: string, fromDomain: string): boolean {
  if (!domain || !fromDomain) return false;
  return domain === fromDomain || fromDomain.endsWith(`.${domain}`) || domain.endsWith(`.${fromDomain}`);
}

/** The verifying server's name, the first token of the header. */
function authservId(header: string): string {
  return header.split(';')[0].trim().split(/\s+/)[0].toLowerCase();
}

/** Every `method=result` with its properties (`header.d=…`, `smtp.mailfrom=…`); comments in `(...)` are dropped first. */
function results(header: string): Array<{ method: string; result: string; props: Record<string, string> }> {
  const clean = header.replace(/\r?\n[ \t]+/g, ' ').replace(/\([^()]*\)/g, ' ');
  return clean.split(';').slice(1).flatMap((part) => {
    const match = /^\s*([a-z]+)\s*=\s*([a-z]+)/i.exec(part);
    if (!match) return [];
    const props: Record<string, string> = {};
    for (const prop of part.matchAll(/([a-z]+\.[a-z-]+)\s*=\s*("?)([^\s";]+)\2/gi)) props[prop[1].toLowerCase()] = prop[3];
    return [{ method: match[1].toLowerCase(), result: match[2].toLowerCase(), props }];
  });
}

/**
 * Used by the e-mail adapter to stamp `raw.senderAuth`. `headers` are the
 * message's Authentication-Results values top first; the topmost ones from the
 * same server (Postfix with OpenDKIM/OpenDMARC writes one per method) are read.
 */
export function readSenderAuth(headers: string[], fromAddress: string): SenderAuth | null {
  if (!headers.length) return null;
  const server = authservId(headers[0]);
  const ours: string[] = [];
  for (const header of headers) {
    if (authservId(header) !== server) break;
    ours.push(header);
  }
  const fromDomain = domainOf(fromAddress);
  const entries = ours.flatMap(results);
  const passed = entries.some(({ method, result, props }) => result === 'pass' && (
    method === 'dmarc'
    || (method === 'dkim' && aligned(domainOf(props['header.d'] ?? props['header.i'] ?? ''), fromDomain))
    || (method === 'spf' && aligned(domainOf(props['smtp.mailfrom'] ?? props['smtp.helo'] ?? ''), fromDomain))
  ));
  if (passed) return 'pass';
  // Hard failures only. DMARC fail is the From domain itself disowning the mail; an SPF fail counts
  // only for the From domain (a bounce address at a mailing service says nothing about it). A broken
  // DKIM signature is treated like none (RFC 6376 §6.1) — a footer or antivirus breaks them.
  const failed = entries.some(({ method, result, props }) => result === 'fail' && (
    method === 'dmarc'
    || (method === 'spf' && aligned(domainOf(props['smtp.mailfrom'] ?? ''), fromDomain))
  ));
  return failed ? 'fail' : null;
}

/**
 * Used by the rules (sender filters) and by the Tasks module (replies routed to
 * a task): true when the receiving server said the sender is forged.
 * Accepts a message's `raw` object or its stored `raw_json`.
 */
export function senderFailedAuth(raw: unknown): boolean {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  return Boolean(value && typeof value === 'object' && (value as { senderAuth?: unknown }).senderAuth === 'fail');
}

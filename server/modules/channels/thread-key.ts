import { randomUUID } from 'node:crypto';

function cleanMessageId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^<|>$/g, '').toLowerCase();
  return trimmed || null;
}

/**
 * The key every message in one e-mail conversation shares: the root of the
 * `References` chain, falling back to `In-Reply-To`, then the message's own id.
 */
export function emailThreadKey(headers: {
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string[] | string | null;
}): string {
  const references = Array.isArray(headers.references)
    ? headers.references
    : typeof headers.references === 'string'
      ? headers.references.split(/\s+/)
      : [];
  for (const reference of references) {
    const cleaned = cleanMessageId(reference);
    if (cleaned) return cleaned;
  }
  return cleanMessageId(headers.inReplyTo) ?? cleanMessageId(headers.messageId) ?? randomUUID();
}

/** WhatsApp already has a per-chat id; a direct chat and a group are both one JID. */
export function whatsappThreadKey(remoteJid: string): string {
  return remoteJid.trim();
}

/**
 * Canonical form of a sender for matching and de-duplication: e-mail addresses
 * lose their display name and case, phone numbers keep only `+` and digits.
 */
export function normalizeAddress(value: string): string {
  const trimmed = value.trim();
  const angle = /<([^>]+)>/.exec(trimmed);
  const candidate = (angle ? angle[1] : trimmed).trim();
  if (candidate.includes('@')) {
    return candidate.toLowerCase();
  }
  if (/^\+?[\d\s().-]+$/.test(candidate)) {
    const digits = candidate.replace(/[^\d]/g, '');
    return digits ? `+${digits}` : '';
  }
  return candidate.toLowerCase();
}

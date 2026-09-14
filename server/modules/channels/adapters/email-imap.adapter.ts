import { randomUUID } from 'node:crypto';

import { simpleParser } from 'mailparser';
import type { AddressObject, ParsedMail } from 'mailparser';

import type { AdapterDeps, AdapterHooks, ChannelAdapter, SendInput } from '@/modules/channels/adapters/channel-adapter.js';
import { storeAttachments } from '@/modules/channels/adapters/webhook.adapter.js';
import { emailThreadKey } from '@/modules/channels/thread-key.js';
import { parseJson } from '@/modules/channels/types.js';
import type { ChannelAccountRow, InboundMessage } from '@/modules/channels/types.js';

export type EmailAccountConfig = {
  host: string;
  port?: number;
  secure?: boolean;
  user: string;
  mailbox?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  fromAddress?: string;
  /** Highest UID already handled; anything older than the first start is left alone. */
  lastUid?: number;
};

export const GMAIL_PRESET = {
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  smtpHost: 'smtp.gmail.com',
  smtpPort: 465,
  smtpSecure: true,
};

/** When IDLE is silently dead a poll every minute still catches new mail. */
const POLL_INTERVAL_MS = 60_000;
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000;

/** The slice of imapflow the adapter uses, so tests can hand in a fake. */
export type ImapClientLike = {
  connect(): Promise<void>;
  logout(): Promise<void>;
  mailboxOpen(path: string): Promise<{ uidNext: number; exists: number }>;
  fetch(range: string, query: { uid: true; source: true }, options: { uid: true }): AsyncIterable<{ uid: number; source?: Buffer }>;
  on(event: 'exists' | 'close' | 'error', listener: (payload?: unknown) => void): unknown;
  usable?: boolean;
};

export type MailTransportLike = {
  sendMail(message: {
    from: string;
    to: string;
    subject?: string;
    text: string;
    inReplyTo?: string;
    references?: string[];
  }): Promise<{ messageId: string }>;
};

export type EmailAdapterOptions = {
  imapFactory?: (options: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } }) => ImapClientLike;
  transportFactory?: (options: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } }) => MailTransportLike;
};

function addressList(value: AddressObject | AddressObject[] | undefined): Array<{ address: string; name?: string }> {
  const objects = Array.isArray(value) ? value : value ? [value] : [];
  return objects.flatMap((object) => object.value.map((entry) => ({ address: (entry.address ?? '').toLowerCase(), name: entry.name || undefined })));
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Turns one raw RFC822 message into the normalized inbound shape. */
export async function parseEmailToInbound(accountId: string, uid: number, source: Buffer, deps: AdapterDeps): Promise<InboundMessage> {
  const parsed: ParsedMail = await simpleParser(source);
  const id = randomUUID();
  const from = addressList(parsed.from)[0] ?? { address: 'unknown' };
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
  const replyTo = addressList(parsed.replyTo)[0]?.address;

  const { attachments, skipped } = storeAttachments(
    id,
    (parsed.attachments ?? []).map((attachment, index) => ({
      name: attachment.filename || `attachment-${index + 1}`,
      mime: attachment.contentType || 'application/octet-stream',
      content: attachment.content,
    })),
    deps,
  );

  const text = (parsed.text ?? '').trim() || (typeof parsed.html === 'string' ? stripHtml(parsed.html) : '');

  return {
    id,
    accountId,
    channel: 'email',
    externalId: parsed.messageId?.trim() || `uid:${uid}`,
    threadKey: emailThreadKey({ messageId: parsed.messageId, inReplyTo: parsed.inReplyTo, references }),
    from: { address: from.address, name: from.name },
    to: [...addressList(parsed.to), ...addressList(parsed.cc)].map((entry) => entry.address).filter(Boolean),
    subject: parsed.subject || undefined,
    text,
    html: typeof parsed.html === 'string' ? parsed.html : undefined,
    isGroup: false,
    attachments,
    receivedAt: (parsed.date ?? new Date()).toISOString(),
    raw: {
      uid,
      messageId: parsed.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
      references,
      replyTo: replyTo ?? null,
      ...(skipped.length ? { skippedAttachments: skipped } : {}),
    },
  };
}

function readEmailConfig(account: ChannelAccountRow): EmailAccountConfig {
  return parseJson<EmailAccountConfig>(account.config, { host: '', user: '' });
}

function readPassword(account: ChannelAccountRow): string {
  return String(parseJson<Record<string, unknown>>(account.secrets, {}).password ?? '');
}

function imapOptions(config: EmailAccountConfig, password: string) {
  return {
    host: config.host,
    port: config.port ?? 993,
    secure: config.secure ?? true,
    auth: { user: config.user, pass: password },
  };
}

function smtpOptions(config: EmailAccountConfig, password: string) {
  return {
    host: config.smtpHost || config.host.replace(/^imap\./i, 'smtp.'),
    port: config.smtpPort ?? 465,
    secure: config.smtpSecure ?? true,
    auth: { user: config.user, pass: password },
  };
}

async function defaultImapFactory(options: ReturnType<typeof imapOptions>): Promise<ImapClientLike> {
  const { ImapFlow } = await import('imapflow');
  return new ImapFlow({ ...options, logger: false }) as unknown as ImapClientLike;
}

async function defaultTransportFactory(options: ReturnType<typeof smtpOptions>): Promise<MailTransportLike> {
  const nodemailer = await import('nodemailer');
  return nodemailer.default.createTransport(options) as unknown as MailTransportLike;
}

export function createEmailAdapter(deps: AdapterDeps, options: EmailAdapterOptions = {}): ChannelAdapter {
  let account: ChannelAccountRow | null = null;
  let hooks: AdapterHooks | null = null;
  let client: ImapClientLike | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let stopped = false;
  let fetching = false;
  let lastUid = 0;

  const makeImap = async (config: EmailAccountConfig, password: string): Promise<ImapClientLike> =>
    options.imapFactory ? options.imapFactory(imapOptions(config, password)) : defaultImapFactory(imapOptions(config, password));

  const makeTransport = async (config: EmailAccountConfig, password: string): Promise<MailTransportLike> =>
    options.transportFactory ? options.transportFactory(smtpOptions(config, password)) : defaultTransportFactory(smtpOptions(config, password));

  async function fetchNew(): Promise<void> {
    if (!client || !account || !hooks || fetching) return;
    fetching = true;
    try {
      for await (const message of client.fetch(`${lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
        // A `${n}:*` range on a mailbox whose last UID is below n echoes the last message back.
        if (message.uid <= lastUid || !message.source) continue;
        try {
          const inbound = await parseEmailToInbound(account.id, message.uid, message.source, deps);
          await hooks.onMessage(inbound);
        } catch (error) {
          deps.log(`failed to handle UID ${message.uid}`, error instanceof Error ? error.message : error);
        }
        lastUid = Math.max(lastUid, message.uid);
        deps.saveConfig({ lastUid });
      }
    } catch (error) {
      deps.log('fetch failed', error instanceof Error ? error.message : error);
      hooks?.onStatus('error', error instanceof Error ? error.message : String(error));
    } finally {
      fetching = false;
    }
  }

  function clearTimers(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  async function connect(): Promise<void> {
    if (!account || !hooks || stopped) return;
    const config = readEmailConfig(account);
    const password = readPassword(account);
    hooks.onStatus('connecting');
    try {
      const next = await makeImap(config, password);
      client = next;
      next.on('close', () => {
        if (client !== next) return;
        client = null;
        if (!stopped) {
          hooks?.onStatus('error', 'Connection closed.');
          scheduleReconnect();
        }
      });
      next.on('error', (error) => {
        deps.log('imap error', error instanceof Error ? error.message : error);
      });
      await next.connect();
      const mailbox = await next.mailboxOpen(config.mailbox || 'INBOX');
      if (typeof config.lastUid === 'number' && config.lastUid > 0) {
        lastUid = config.lastUid;
      } else {
        // First start: remember where the mailbox ends so old mail never triggers anything.
        lastUid = Math.max(mailbox.uidNext - 1, 0);
        deps.saveConfig({ lastUid });
      }
      next.on('exists', () => { void fetchNew(); });
      reconnectDelay = RECONNECT_MIN_MS;
      hooks.onStatus('connected');
      await fetchNew();
      if (!pollTimer) {
        pollTimer = setInterval(() => { void fetchNew(); }, POLL_INTERVAL_MS);
        pollTimer.unref?.();
      }
    } catch (error) {
      client = null;
      const detail = error instanceof Error ? error.message : String(error);
      hooks.onStatus('error', detail);
      scheduleReconnect();
    }
  }

  return {
    type: 'email',

    async start(nextAccount, nextHooks) {
      account = nextAccount;
      hooks = nextHooks;
      stopped = false;
      await connect();
    },

    async stop() {
      stopped = true;
      clearTimers();
      const current = client;
      client = null;
      if (current) {
        try {
          await current.logout();
        } catch {
          // Already gone.
        }
      }
      hooks?.onStatus('disconnected');
    },

    async send(input: SendInput) {
      if (!account) throw new Error('E-mail account is not running.');
      const config = readEmailConfig(account);
      const transport = await makeTransport(config, readPassword(account));
      const raw = input.inReplyTo ? parseJson<Record<string, unknown>>(input.inReplyTo.raw_json, {}) : {};
      const inReplyTo = typeof raw.messageId === 'string' ? raw.messageId : undefined;
      const references = Array.isArray(raw.references) ? (raw.references as string[]) : [];
      const result = await transport.sendMail({
        from: config.fromAddress || config.user,
        to: input.to,
        subject: input.subject ?? (input.inReplyTo?.subject ? `Re: ${input.inReplyTo.subject}` : undefined),
        text: input.text,
        inReplyTo,
        references: inReplyTo ? [...references, inReplyTo] : undefined,
      });
      return { externalId: result.messageId };
    },

    async probe(config, secrets) {
      const emailConfig = config as EmailAccountConfig;
      const password = String(secrets.password ?? '');
      if (!emailConfig.host || !emailConfig.user || !password) {
        return { ok: false, detail: 'Host, user and password are required.' };
      }
      try {
        const probeClient = await makeImap(emailConfig, password);
        probeClient.on('error', () => {});
        await probeClient.connect();
        const mailbox = await probeClient.mailboxOpen(emailConfig.mailbox || 'INBOX');
        await probeClient.logout();
        return { ok: true, detail: `Connected. ${mailbox.exists} messages in ${emailConfig.mailbox || 'INBOX'}.` };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

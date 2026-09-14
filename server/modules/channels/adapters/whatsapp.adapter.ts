import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import type { AdapterDeps, AdapterHooks, ChannelAdapter, SendInput } from '@/modules/channels/adapters/channel-adapter.js';
import { storeAttachments } from '@/modules/channels/adapters/webhook.adapter.js';
import { whatsappThreadKey } from '@/modules/channels/thread-key.js';
import { parseJson } from '@/modules/channels/types.js';
import type { ChannelAccountRow, InboundMessage } from '@/modules/channels/types.js';

export type WhatsAppAccountConfig = {
  phoneNumber?: string;
  pairingMethod?: 'qr' | 'code';
};

const RECONNECT_MIN_MS = 3_000;
const RECONNECT_MAX_MS = 5 * 60_000;
/** baileys' DisconnectReason.loggedOut — the linked device was removed on the phone. */
const LOGGED_OUT = 401;

/** The subset of a baileys message the adapter reads; kept loose so fixtures stay small. */
export type WaMessageLike = {
  key: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null; participant?: string | null };
  pushName?: string | null;
  messageTimestamp?: number | Long | null;
  message?: Record<string, any> | null;
};

type Long = { toNumber(): number };

export type WaSocketLike = {
  ev: { on(event: string, listener: (payload: any) => void): void };
  user?: { id: string } | null;
  sendMessage(jid: string, content: { text: string }, options?: Record<string, unknown>): Promise<{ key: { id?: string | null } } | undefined>;
  requestPairingCode(phoneNumber: string): Promise<string>;
  end(error?: Error): void;
  logout?(): Promise<void>;
  updateMediaMessage?: unknown;
};

export type WhatsAppAdapterOptions = {
  authDir: string;
  socketFactory?: (authDir: string) => Promise<{ sock: WaSocketLike; saveCreds: () => Promise<void>; downloadMedia: (message: WaMessageLike) => Promise<Buffer> }>;
  qrToDataUrl?: (qr: string) => Promise<string>;
};

const MEDIA_KEYS = ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage'] as const;

function unwrap(message: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!message) return null;
  // Ephemeral / view-once wrappers carry the real content one level down.
  const inner = message.ephemeralMessage?.message
    ?? message.viewOnceMessage?.message
    ?? message.viewOnceMessageV2?.message
    ?? message.documentWithCaptionMessage?.message;
  return inner ? unwrap(inner) : message;
}

export function jidToAddress(jid: string): string {
  const [user] = jid.split('@');
  if (jid.endsWith('@s.whatsapp.net') && /^\d+$/.test(user)) return `+${user}`;
  return jid;
}

export function addressToJid(address: string): string {
  const trimmed = address.trim();
  if (trimmed.includes('@')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

function timestampToIso(value: number | Long | null | undefined): string {
  const seconds = typeof value === 'number' ? value : value && typeof value === 'object' ? value.toNumber() : Date.now() / 1000;
  return new Date(seconds * 1000).toISOString();
}

/** Normalizes one upsert entry; returns `mediaMessage` when a download is needed to complete it. */
export function normalizeWaMessage(
  accountId: string,
  raw: WaMessageLike,
  selfJid: string | null,
): { message: InboundMessage | null; mediaKey: (typeof MEDIA_KEYS)[number] | null } {
  const remoteJid = raw.key.remoteJid ?? '';
  const content = unwrap(raw.message);
  if (!remoteJid || !content || remoteJid === 'status@broadcast') {
    return { message: null, mediaKey: null };
  }

  const mediaKey = MEDIA_KEYS.find((key) => content[key]) ?? null;
  const text: string = content.conversation
    ?? content.extendedTextMessage?.text
    ?? (mediaKey ? content[mediaKey]?.caption : undefined)
    ?? '';
  if (!text && !mediaKey) {
    return { message: null, mediaKey: null };
  }

  const isGroup = remoteJid.endsWith('@g.us');
  const senderJid = (isGroup ? raw.key.participant : remoteJid) ?? remoteJid;
  const contextInfo = content.extendedTextMessage?.contextInfo ?? (mediaKey ? content[mediaKey]?.contextInfo : undefined);
  const mentioned: string[] = Array.isArray(contextInfo?.mentionedJid) ? contextInfo.mentionedJid : [];
  const selfUser = selfJid ? selfJid.split(':')[0].split('@')[0] : null;
  const mentionsMe = selfUser ? mentioned.some((jid) => jid.split('@')[0] === selfUser) : false;

  return {
    mediaKey,
    message: {
      id: randomUUID(),
      accountId,
      channel: 'whatsapp',
      externalId: raw.key.id ?? randomUUID(),
      threadKey: whatsappThreadKey(remoteJid),
      from: { address: jidToAddress(senderJid), name: raw.pushName ?? undefined },
      to: [],
      subject: undefined,
      text,
      isGroup,
      attachments: [],
      receivedAt: timestampToIso(raw.messageTimestamp),
      raw: {
        fromMe: raw.key.fromMe === true,
        remoteJid,
        senderJid,
        mentionsMe,
        quotedText: typeof contextInfo?.quotedMessage?.conversation === 'string' ? contextInfo.quotedMessage.conversation : null,
        waKey: { id: raw.key.id ?? null, remoteJid, fromMe: raw.key.fromMe === true, participant: raw.key.participant ?? null },
      },
    },
  };
}

async function defaultSocketFactory(authDir: string) {
  const baileys = await import('@whiskeysockets/baileys');
  const pino = (await import('pino')).default;
  const logger = pino({ level: 'error' });
  const { state, saveCreds } = await baileys.useMultiFileAuthState(authDir);
  let version: [number, number, number] | undefined;
  try {
    version = (await baileys.fetchLatestBaileysVersion()).version as [number, number, number];
  } catch {
    version = undefined;
  }
  const sock = baileys.makeWASocket({
    auth: state,
    logger,
    version,
    browser: baileys.Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    syncFullHistory: false,
    // Staying "offline" keeps push notifications arriving on the phone.
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });
  const downloadMedia = (message: WaMessageLike) => baileys.downloadMediaMessage(
    message as never,
    'buffer',
    {},
    { logger, reuploadRequest: sock.updateMediaMessage },
  ) as Promise<Buffer>;
  return { sock: sock as unknown as WaSocketLike, saveCreds, downloadMedia };
}

async function defaultQrToDataUrl(qr: string): Promise<string> {
  const QRCode = (await import('qrcode')).default;
  return QRCode.toDataURL(qr, { margin: 1, width: 320 });
}

export function createWhatsAppAdapter(deps: AdapterDeps, options: WhatsAppAdapterOptions): ChannelAdapter {
  let account: ChannelAccountRow | null = null;
  let hooks: AdapterHooks | null = null;
  let sock: WaSocketLike | null = null;
  let downloadMedia: ((message: WaMessageLike) => Promise<Buffer>) | null = null;
  let selfJid: string | null = null;
  let qrDataUrl: string | null = null;
  let pairingCode: string | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let stopped = false;

  const socketFactory = options.socketFactory ?? defaultSocketFactory;
  const qrToDataUrl = options.qrToDataUrl ?? defaultQrToDataUrl;

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

  async function handleUpsert(payload: { type?: string; messages?: WaMessageLike[] }): Promise<void> {
    if (!account || !hooks || payload.type !== 'notify') return;
    for (const raw of payload.messages ?? []) {
      try {
        const { message, mediaKey } = normalizeWaMessage(account.id, raw, selfJid);
        if (!message) continue;
        if (mediaKey && downloadMedia && !message.raw.fromMe) {
          try {
            const content = unwrap(raw.message)?.[mediaKey] ?? {};
            const buffer = await downloadMedia(raw);
            const mime: string = content.mimetype || 'application/octet-stream';
            const name: string = content.fileName || `${mediaKey.replace('Message', '')}.${mime.split('/')[1]?.split(';')[0] || 'bin'}`;
            const { attachments, skipped } = storeAttachments(message.id, [{ name, mime, content: buffer }], deps);
            message.attachments = attachments;
            if (skipped.length) message.raw.skippedAttachments = skipped;
          } catch (error) {
            deps.log('media download failed', error instanceof Error ? error.message : error);
            message.raw.mediaError = error instanceof Error ? error.message : String(error);
          }
        }
        await hooks.onMessage(message);
      } catch (error) {
        deps.log('failed to handle message', error instanceof Error ? error.message : error);
      }
    }
  }

  async function connect(): Promise<void> {
    if (!account || !hooks || stopped) return;
    hooks.onStatus('connecting');
    try {
      fs.mkdirSync(options.authDir, { recursive: true, mode: 0o700 });
      const created = await socketFactory(options.authDir);
      const current = created.sock;
      sock = current;
      downloadMedia = created.downloadMedia;

      current.ev.on('creds.update', () => { void created.saveCreds(); });
      current.ev.on('connection.update', (update: { connection?: string; qr?: string; lastDisconnect?: { error?: { output?: { statusCode?: number } } } }) => {
        if (sock !== current) return;
        if (update.qr) {
          void qrToDataUrl(update.qr).then((dataUrl) => {
            qrDataUrl = dataUrl;
            hooks?.onStatus('needs_pairing', 'Scan the QR code in WhatsApp → Linked devices.');
          });
        }
        if (update.connection === 'open') {
          qrDataUrl = null;
          pairingCode = null;
          selfJid = current.user?.id ?? null;
          reconnectDelay = RECONNECT_MIN_MS;
          hooks?.onStatus('connected', selfJid ? `Linked as ${jidToAddress(selfJid.split(':')[0] + '@s.whatsapp.net')}` : null);
        }
        if (update.connection === 'close') {
          const code = update.lastDisconnect?.error?.output?.statusCode;
          sock = null;
          if (code === LOGGED_OUT) {
            fs.rmSync(options.authDir, { recursive: true, force: true });
            qrDataUrl = null;
            hooks?.onStatus('needs_pairing', 'The phone unlinked this device. Pair again.');
            if (!stopped) scheduleReconnect();
            return;
          }
          if (!stopped) {
            hooks?.onStatus('error', `Connection closed (${code ?? 'unknown'}). Reconnecting…`);
            scheduleReconnect();
          }
        }
      });
      current.ev.on('messages.upsert', (payload: { type?: string; messages?: WaMessageLike[] }) => { void handleUpsert(payload); });
    } catch (error) {
      sock = null;
      hooks.onStatus('error', error instanceof Error ? error.message : String(error));
      scheduleReconnect();
    }
  }

  return {
    type: 'whatsapp',

    async start(nextAccount, nextHooks) {
      account = nextAccount;
      hooks = nextHooks;
      stopped = false;
      await connect();
    },

    async stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const current = sock;
      sock = null;
      try {
        current?.end(undefined);
      } catch {
        // Already closed.
      }
      hooks?.onStatus('disconnected');
    },

    async send(input: SendInput) {
      if (!sock) throw new Error('WhatsApp is not connected.');
      const jid = addressToJid(input.to);
      const quoted = input.inReplyTo ? parseJson<Record<string, unknown>>(input.inReplyTo.raw_json, {}).waKey : undefined;
      const text = input.subject && !input.inReplyTo ? `*${input.subject}*\n${input.text}` : input.text;
      const result = await sock.sendMessage(jid, { text }, quoted ? { quoted: { key: quoted, message: { conversation: input.inReplyTo?.text ?? '' } } } : undefined);
      return { externalId: result?.key?.id ?? randomUUID() };
    },

    getPairing() {
      return { qrDataUrl, pairingCode };
    },

    async requestPairingCode(phoneNumber: string) {
      if (!sock) throw new Error('WhatsApp socket is not ready yet — try again in a few seconds.');
      pairingCode = await sock.requestPairingCode(phoneNumber.replace(/\D/g, ''));
      hooks?.onStatus('needs_pairing', 'Enter the pairing code in WhatsApp → Linked devices → Link with phone number.');
      return pairingCode;
    },

    async probe(config) {
      const waConfig = config as WhatsAppAccountConfig;
      const hasCreds = fs.existsSync(`${options.authDir}/creds.json`);
      return {
        ok: hasCreds,
        detail: hasCreds
          ? `Linked device credentials present${waConfig.phoneNumber ? ` for ${waConfig.phoneNumber}` : ''}.`
          : 'Not paired yet — open the account card to scan the QR code.',
      };
    },
  };
}

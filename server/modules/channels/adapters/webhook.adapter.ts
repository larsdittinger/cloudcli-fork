import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AdapterDeps, AdapterHooks, ChannelAdapter, SendInput } from '@/modules/channels/adapters/channel-adapter.js';
import type { ChannelAccountRow, InboundAttachment, InboundMessage } from '@/modules/channels/types.js';
import { AppError } from '@/shared/utils.js';

/** Attachments over this are skipped rather than failing the whole message. */
export const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024;

function safeFileName(name: string, fallback: string): string {
  const cleaned = path.basename(name).replace(/[^\w.\-()\s]/g, '_').trim();
  return cleaned || fallback;
}

/** Writes decoded attachments into the message folder, honouring the size cap. */
export function storeAttachments(
  messageId: string,
  files: Array<{ name: string; mime: string; content: Buffer }>,
  deps: AdapterDeps,
): { attachments: InboundAttachment[]; skipped: string[] } {
  const attachments: InboundAttachment[] = [];
  const skipped: string[] = [];
  let total = 0;
  let dir: string | null = null;

  files.forEach((file, index) => {
    if (total + file.content.length > MAX_ATTACHMENTS_BYTES) {
      skipped.push(file.name);
      return;
    }
    if (!dir) {
      dir = deps.attachmentsDir(messageId);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const fileName = `${index + 1}-${safeFileName(file.name, `attachment-${index + 1}`)}`;
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, file.content, { mode: 0o600 });
    total += file.content.length;
    attachments.push({ name: file.name, mime: file.mime || 'application/octet-stream', size: file.content.length, path: filePath });
  });

  return { attachments, skipped };
}

type WebhookPayload = {
  id?: unknown;
  from?: unknown;
  name?: unknown;
  subject?: unknown;
  text?: unknown;
  thread?: unknown;
  attachments?: unknown;
};

/** Turns a webhook body into the normalized shape; throws 400 on anything unusable. */
export function normalizeWebhookPayload(accountId: string, body: unknown, deps: AdapterDeps): InboundMessage {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Webhook body must be a JSON object.', { code: 'WEBHOOK_PAYLOAD_INVALID', statusCode: 400 });
  }
  const payload = body as WebhookPayload;
  const from = typeof payload.from === 'string' ? payload.from.trim() : '';
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!from) {
    throw new AppError('Webhook body needs a "from".', { code: 'WEBHOOK_PAYLOAD_INVALID', statusCode: 400 });
  }
  if (!text.trim()) {
    throw new AppError('Webhook body needs a "text".', { code: 'WEBHOOK_PAYLOAD_INVALID', statusCode: 400 });
  }

  const receivedAt = new Date().toISOString();
  const id = randomUUID();
  const externalId = typeof payload.id === 'string' && payload.id.trim()
    ? payload.id.trim()
    : createHash('sha256').update(`${from}\n${text}\n${receivedAt.slice(0, 16)}`).digest('hex');

  const files = Array.isArray(payload.attachments)
    ? payload.attachments
      .filter((item): item is { name?: unknown; mime?: unknown; contentBase64?: unknown } => !!item && typeof item === 'object')
      .filter((item) => typeof item.contentBase64 === 'string')
      .map((item, index) => ({
        name: typeof item.name === 'string' && item.name ? item.name : `attachment-${index + 1}`,
        mime: typeof item.mime === 'string' ? item.mime : 'application/octet-stream',
        content: Buffer.from(item.contentBase64 as string, 'base64'),
      }))
    : [];
  const { attachments, skipped } = storeAttachments(id, files, deps);

  return {
    id,
    accountId,
    channel: 'webhook',
    externalId,
    threadKey: typeof payload.thread === 'string' && payload.thread.trim() ? payload.thread.trim() : externalId,
    from: { address: from, name: typeof payload.name === 'string' ? payload.name : undefined },
    to: [],
    subject: typeof payload.subject === 'string' ? payload.subject : undefined,
    text,
    isGroup: false,
    attachments,
    receivedAt,
    raw: { ...(skipped.length ? { skippedAttachments: skipped } : {}) },
  };
}

export type WebhookAdapter = ChannelAdapter & { ingestPayload(body: unknown): Promise<InboundMessage> };

export function createWebhookAdapter(deps: AdapterDeps): WebhookAdapter {
  let account: ChannelAccountRow | null = null;
  let hooks: AdapterHooks | null = null;

  return {
    type: 'webhook',

    async start(nextAccount, nextHooks) {
      account = nextAccount;
      hooks = nextHooks;
      hooks.onStatus('connected');
    },

    async stop() {
      hooks?.onStatus('disconnected');
      hooks = null;
    },

    async ingestPayload(body) {
      if (!account || !hooks) {
        throw new AppError('Webhook account is not running.', { code: 'WEBHOOK_ACCOUNT_STOPPED', statusCode: 503 });
      }
      const message = normalizeWebhookPayload(account.id, body, deps);
      await hooks.onMessage(message);
      return message;
    },

    async send(input: SendInput) {
      const config = account ? (JSON.parse(account.config || '{}') as { replyUrl?: string }) : {};
      const replyUrl = typeof config.replyUrl === 'string' ? config.replyUrl.trim() : '';
      if (!replyUrl) {
        throw new Error('This webhook account has no replyUrl, so there is nowhere to send a reply.');
      }
      const response = await fetch(replyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: input.to,
          text: input.text,
          subject: input.subject ?? null,
          inReplyTo: input.inReplyTo ? { id: input.inReplyTo.id, externalId: input.inReplyTo.external_id, thread: input.inReplyTo.thread_key } : null,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new Error(`replyUrl answered ${response.status}.`);
      }
      return { externalId: `webhook:${randomUUID()}` };
    },

    async probe(config) {
      const replyUrl = typeof config.replyUrl === 'string' ? config.replyUrl.trim() : '';
      return { ok: true, detail: replyUrl ? `Replies will be posted to ${replyUrl}.` : 'Inbound only — no replyUrl configured.' };
    },
  };
}

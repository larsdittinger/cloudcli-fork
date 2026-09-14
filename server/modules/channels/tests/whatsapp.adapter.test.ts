import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';

import { addressToJid, createWhatsAppAdapter, jidToAddress, normalizeWaMessage } from '@/modules/channels/adapters/whatsapp.adapter.js';
import type { WaMessageLike, WaSocketLike } from '@/modules/channels/adapters/whatsapp.adapter.js';
import { withIsolatedDatabase } from '@/modules/channels/tests/helpers.js';
import type { ChannelAccountRow, InboundMessage } from '@/modules/channels/types.js';

function deps(dir: string) {
  return { accountId: 'acc', attachmentsDir: (id: string) => path.join(dir, 'attachments', id), saveConfig: () => {}, log: () => {} };
}

const account: ChannelAccountRow = {
  id: 'acc-wa', type: 'whatsapp', label: 'WA', enabled: 1, config: '{}', secrets: '{}', agent_send: 'off',
  status: 'disconnected', status_detail: null, last_seen_at: null, created_at: '', updated_at: '',
};

test('normalizeWaMessage: DM, group with mention, fromMe, reaction, media caption', () => {
  const dm = normalizeWaMessage('acc', {
    key: { id: 'ABC', remoteJid: '420777123456@s.whatsapp.net', fromMe: false },
    pushName: 'Jan',
    messageTimestamp: 1_789_000_000,
    message: { conversation: 'ahoj' },
  }, '420111222333:12@s.whatsapp.net');
  assert.equal(dm.message?.from.address, '+420777123456');
  assert.equal(dm.message?.from.name, 'Jan');
  assert.equal(dm.message?.text, 'ahoj');
  assert.equal(dm.message?.threadKey, '420777123456@s.whatsapp.net');
  assert.equal(dm.message?.externalId, 'ABC');
  assert.equal(dm.message?.isGroup, false);
  assert.equal(dm.message?.receivedAt, new Date(1_789_000_000 * 1000).toISOString());
  assert.equal(dm.mediaKey, null);

  const group = normalizeWaMessage('acc', {
    key: { id: 'G1', remoteJid: '1203630@g.us', fromMe: false, participant: '420777123456@s.whatsapp.net' },
    message: { extendedTextMessage: { text: '@420111222333 pomoz', contextInfo: { mentionedJid: ['420111222333@s.whatsapp.net'] } } },
  }, '420111222333:12@s.whatsapp.net');
  assert.equal(group.message?.isGroup, true);
  assert.equal(group.message?.from.address, '+420777123456');
  assert.equal(group.message?.raw.mentionsMe, true);

  const mine = normalizeWaMessage('acc', { key: { id: 'M', remoteJid: 'x@s.whatsapp.net', fromMe: true }, message: { conversation: 'me' } }, null);
  assert.equal(mine.message?.raw.fromMe, true);

  const reaction = normalizeWaMessage('acc', { key: { id: 'R', remoteJid: 'x@s.whatsapp.net' }, message: { reactionMessage: { text: '👍' } } }, null);
  assert.equal(reaction.message, null);

  const image = normalizeWaMessage('acc', {
    key: { id: 'I', remoteJid: 'x@s.whatsapp.net' },
    message: { imageMessage: { caption: 'foto', mimetype: 'image/jpeg' } },
  }, null);
  assert.equal(image.mediaKey, 'imageMessage');
  assert.equal(image.message?.text, 'foto');

  assert.equal(jidToAddress('abc@g.us'), 'abc@g.us');
  assert.equal(addressToJid('+420 777 123 456'), '420777123456@s.whatsapp.net');
  assert.equal(addressToJid('1203630@g.us'), '1203630@g.us');
});

class FakeSocket implements WaSocketLike {
  ev = new EventEmitter();
  user: { id: string } | null = null;
  sent: Array<{ jid: string; content: { text: string }; options?: Record<string, unknown> }> = [];
  ended = false;
  async sendMessage(jid: string, content: { text: string }, options?: Record<string, unknown>) {
    this.sent.push({ jid, content, options });
    return { key: { id: 'OUT1' } };
  }
  async requestPairingCode(phone: string) { return `CODE-${phone}`; }
  end() { this.ended = true; }
}

test('adapter: QR pairing, open, inbound with media, send with quote, logged-out resets', async () => {
  await withIsolatedDatabase(async (dir) => {
    const sock = new FakeSocket();
    const received: InboundMessage[] = [];
    const statuses: Array<[string, string | null | undefined]> = [];
    const adapter = createWhatsAppAdapter(deps(dir), {
      authDir: path.join(dir, 'wa-auth'),
      socketFactory: async () => ({ sock, saveCreds: async () => {}, downloadMedia: async () => Buffer.from('jpegdata') }),
      qrToDataUrl: async (qr) => `data:image/png;base64,${Buffer.from(qr).toString('base64')}`,
    });

    await adapter.start(account, {
      onMessage: async (message) => { received.push(message); },
      onStatus: (status, detail) => { statuses.push([status, detail]); },
    });

    sock.ev.emit('connection.update', { qr: 'qr-payload' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(adapter.getPairing?.().qrDataUrl?.startsWith('data:image/png'));
    assert.equal(statuses.at(-1)?.[0], 'needs_pairing');

    assert.equal(await adapter.requestPairingCode?.('+420 777 123 456'), 'CODE-420777123456');
    assert.equal(adapter.getPairing?.().pairingCode, 'CODE-420777123456');

    sock.user = { id: '420111222333:5@s.whatsapp.net' };
    sock.ev.emit('connection.update', { connection: 'open' });
    assert.equal(statuses.at(-1)?.[0], 'connected');
    assert.equal(adapter.getPairing?.().qrDataUrl, null);

    sock.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        { key: { id: 'T1', remoteJid: '420777123456@s.whatsapp.net' }, pushName: 'Jan', message: { conversation: 'text' } },
        { key: { id: 'P1', remoteJid: '420777123456@s.whatsapp.net' }, message: { imageMessage: { caption: 'foto', mimetype: 'image/jpeg' } } },
        { key: { id: 'A1', remoteJid: '420777123456@s.whatsapp.net' }, message: { conversation: 'append' } },
      ],
    });
    sock.ev.emit('messages.upsert', { type: 'append', messages: [{ key: { id: 'H', remoteJid: 'x@s.whatsapp.net' }, message: { conversation: 'history' } }] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(received.map((message) => message.externalId), ['T1', 'P1', 'A1']);
    assert.equal(received[1].attachments.length, 1);
    assert.equal(received[1].attachments[0].mime, 'image/jpeg');
    assert.equal(received[1].attachments[0].size, 8);

    const result = await adapter.send({
      to: '+420777123456',
      text: 'odpoved',
      inReplyTo: {
        id: 'm', account_id: 'acc-wa', channel: 'whatsapp', external_id: 'T1', thread_key: '420777123456@s.whatsapp.net',
        from_address: '+420777123456', from_name: 'Jan', to_json: '[]', subject: null, text: 'text', html: null, is_group: 0,
        attachments_json: '[]', raw_json: JSON.stringify({ waKey: { id: 'T1', remoteJid: '420777123456@s.whatsapp.net', fromMe: false, participant: null } }),
        received_at: '', rule_id: null, session_id: null, status: 'dispatched', status_detail: null, created_at: '',
      },
    });
    assert.equal(result.externalId, 'OUT1');
    assert.equal(sock.sent[0].jid, '420777123456@s.whatsapp.net');
    assert.equal((sock.sent[0].options as { quoted: { key: { id: string } } }).quoted.key.id, 'T1');

    sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    assert.equal(statuses.at(-1)?.[0], 'needs_pairing');

    await adapter.stop();
    assert.equal(statuses.at(-1)?.[0], 'disconnected');
  });
});

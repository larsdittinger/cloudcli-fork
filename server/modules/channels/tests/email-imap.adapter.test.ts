import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createEmailAdapter, parseEmailToInbound } from '@/modules/channels/adapters/email-imap.adapter.js';
import type { ImapClientLike, MailTransportLike } from '@/modules/channels/adapters/email-imap.adapter.js';
import { withIsolatedDatabase } from '@/modules/channels/tests/helpers.js';
import type { ChannelAccountRow, InboundMessage } from '@/modules/channels/types.js';

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');

function deps(dir: string, saved: Record<string, unknown>[] = []) {
  return {
    accountId: 'acc',
    attachmentsDir: (messageId: string) => path.join(dir, 'attachments', messageId),
    saveConfig: (patch: Record<string, unknown>) => { saved.push(patch); },
    log: () => {},
  };
}

function account(config: Record<string, unknown>): ChannelAccountRow {
  return {
    id: 'acc-mail', type: 'email', label: 'Mail', enabled: 1, config: JSON.stringify(config), secrets: JSON.stringify({ password: 'pw' }),
    agent_send: 'off', status: 'disconnected', status_detail: null, last_seen_at: null, created_at: '', updated_at: '',
  };
}

test('parseEmailToInbound: threading, reply-to, attachments, html fallback', async () => {
  await withIsolatedDatabase(async (dir) => {
    const reply = await parseEmailToInbound('acc', 7, fs.readFileSync(path.join(FIXTURES, 'reply.eml')), deps(dir));
    assert.equal(reply.externalId, '<c@firma.cz>');
    assert.equal(reply.threadKey, 'a@example.com');
    assert.equal(reply.from.address, 'jan@firma.cz');
    assert.equal(reply.from.name, 'Jan Novak');
    assert.deepEqual(reply.to, ['me@example.com', 'kolega@firma.cz']);
    assert.equal(reply.subject, 'Re: Objednavka 42');
    assert.equal(reply.text, 'Dobry den, posilam upresneni.');
    assert.equal(reply.raw.replyTo, 'reply@firma.cz');
    assert.equal(reply.attachments.length, 1);
    assert.equal(reply.attachments[0].size, 5);
    assert.equal(fs.readFileSync(reply.attachments[0].path, 'utf8'), 'hello');

    const html = await parseEmailToInbound('acc', 8, fs.readFileSync(path.join(FIXTURES, 'html-only.eml')), deps(dir));
    assert.equal(html.threadKey, 'n1@example.org');
    assert.ok(html.text.toLowerCase().includes('hello'));
    assert.ok(html.text.includes('First & second'));
    assert.ok(!html.text.includes('<'));
    assert.ok(html.html?.includes('<h1>'));
  });
});

class FakeImap extends EventEmitter implements ImapClientLike {
  connected = false;
  loggedOut = false;
  fetched: string[] = [];
  constructor(private readonly uidNext: number, readonly messages: Array<{ uid: number; source: Buffer }>) { super(); }
  async connect() { this.connected = true; }
  async logout() { this.loggedOut = true; }
  async mailboxOpen() { return { uidNext: this.uidNext, exists: this.messages.length }; }
  async *fetch(range: string) {
    this.fetched.push(range);
    const from = Number(range.split(':')[0]);
    const matching = this.messages.filter((message) => message.uid >= from);
    // IMAP echoes the last message when the range starts past the end.
    yield* (matching.length ? matching : this.messages.slice(-1));
  }
}

test('start: first run only remembers the UID boundary; a later exists event fetches the new mail', async () => {
  await withIsolatedDatabase(async (dir) => {
    const source = fs.readFileSync(path.join(FIXTURES, 'reply.eml'));
    const imap = new FakeImap(11, [{ uid: 9, source }, { uid: 10, source }]);
    const saved: Record<string, unknown>[] = [];
    const received: InboundMessage[] = [];
    const statuses: string[] = [];

    const adapter = createEmailAdapter(deps(dir, saved), { imapFactory: () => imap });
    await adapter.start(account({ host: 'imap.example.com', user: 'me@example.com' }), {
      onMessage: async (message) => { received.push(message); },
      onStatus: (status) => { statuses.push(status); },
    });

    assert.deepEqual(statuses, ['connecting', 'connected']);
    assert.deepEqual(saved[0], { lastUid: 10 });
    assert.equal(received.length, 0, 'old mail must not trigger anything');

    imap.messages.push({ uid: 11, source });
    imap.emit('exists');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received.length, 1);
    assert.equal(received[0].raw.uid, 11);
    assert.deepEqual(saved.at(-1), { lastUid: 11 });

    await adapter.stop();
    assert.equal(imap.loggedOut, true);
    assert.equal(statuses.at(-1), 'disconnected');
  });
});

test('start with a remembered lastUid fetches everything newer straight away', async () => {
  await withIsolatedDatabase(async (dir) => {
    const source = fs.readFileSync(path.join(FIXTURES, 'reply.eml'));
    const imap = new FakeImap(13, [{ uid: 10, source }, { uid: 11, source }, { uid: 12, source }]);
    const received: InboundMessage[] = [];
    const adapter = createEmailAdapter(deps(dir), { imapFactory: () => imap });
    await adapter.start(account({ host: 'imap.example.com', user: 'me@example.com', lastUid: 10 }), {
      onMessage: async (message) => { received.push(message); },
      onStatus: () => {},
    });
    assert.deepEqual(received.map((message) => message.raw.uid), [11, 12]);
    assert.equal(imap.fetched[0], '11:*');
    await adapter.stop();
  });
});

test('send threads the reply and derives the SMTP host from the IMAP host', async () => {
  await withIsolatedDatabase(async (dir) => {
    const sent: Array<Record<string, unknown>> = [];
    const transportOptions: Array<Record<string, unknown>> = [];
    const transport: MailTransportLike = { sendMail: async (message) => { sent.push(message); return { messageId: '<out@x>' }; } };
    const adapter = createEmailAdapter(deps(dir), {
      imapFactory: () => new FakeImap(1, []),
      transportFactory: (options) => { transportOptions.push(options); return transport; },
    });
    await adapter.start(account({ host: 'imap.gmail.com', user: 'me@gmail.com' }), { onMessage: async () => {}, onStatus: () => {} });

    const result = await adapter.send({
      to: 'jan@firma.cz',
      text: 'Odpoved',
      subject: 'Re: Objednavka 42',
      inReplyTo: {
        id: 'm', account_id: 'acc-mail', channel: 'email', external_id: '<c@firma.cz>', thread_key: 'a@example.com',
        from_address: 'jan@firma.cz', from_name: null, to_json: '[]', subject: 'Objednavka 42', text: '', html: null, is_group: 0,
        attachments_json: '[]', raw_json: JSON.stringify({ messageId: '<c@firma.cz>', references: ['<a@example.com>', '<b@example.com>'] }),
        received_at: '', rule_id: null, session_id: null, status: 'dispatched', status_detail: null, created_at: '',
      },
    });

    assert.equal(result.externalId, '<out@x>');
    assert.equal(transportOptions[0].host, 'smtp.gmail.com');
    assert.equal(sent[0].from, 'me@gmail.com');
    assert.equal(sent[0].inReplyTo, '<c@firma.cz>');
    assert.deepEqual(sent[0].references, ['<a@example.com>', '<b@example.com>', '<c@firma.cz>']);
    assert.equal(sent[0].subject, 'Re: Objednavka 42');
    await adapter.stop();
  });
});

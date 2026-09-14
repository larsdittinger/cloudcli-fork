import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTemplateVars, DEFAULT_PROMPT_TEMPLATE, renderPromptTemplate } from '@/modules/channels/prompt-template.js';
import { findMatchingRule, senderMatches, validateRuleInput } from '@/modules/channels/rules.service.js';
import { emailThreadKey, normalizeAddress, whatsappThreadKey } from '@/modules/channels/thread-key.js';
import { makeMessage } from '@/modules/channels/tests/helpers.js';
import type { ChannelAccountRow, ChannelRuleRow } from '@/modules/channels/types.js';

test('emailThreadKey prefers the root of References, then In-Reply-To, then Message-ID', () => {
  assert.equal(emailThreadKey({ references: ['<a@x>', '<b@x>'], inReplyTo: '<b@x>', messageId: '<c@x>' }), 'a@x');
  assert.equal(emailThreadKey({ references: '<A@X> <b@x>', messageId: '<c@x>' }), 'a@x');
  assert.equal(emailThreadKey({ inReplyTo: '<b@x>', messageId: '<c@x>' }), 'b@x');
  assert.equal(emailThreadKey({ messageId: '<c@x>' }), 'c@x');
  assert.equal(emailThreadKey({}).length, 36);
  assert.equal(whatsappThreadKey(' 420777123456@s.whatsapp.net '), '420777123456@s.whatsapp.net');
});

test('normalizeAddress strips display names and formats phone numbers', () => {
  assert.equal(normalizeAddress('"Jan" <Jan@Firma.CZ>'), 'jan@firma.cz');
  assert.equal(normalizeAddress('+420 777 123 456'), '+420777123456');
  assert.equal(normalizeAddress('420777123456'), '+420777123456');
  assert.equal(normalizeAddress('  Someone  '), 'someone');
});

test('renderPromptTemplate drops label lines whose placeholder is empty', () => {
  const output = renderPromptTemplate('Od: {{from}}\nPředmět: {{subject}}\n\n{{text}}\n\n{{replyInstructions}}', {
    from: 'jan@firma.cz',
    subject: '',
    text: 'Ahoj',
    replyInstructions: '',
  });
  assert.equal(output, 'Od: jan@firma.cz\n\nAhoj');
});

test('buildTemplateVars carries reply instructions only when replies are allowed', () => {
  const message = makeMessage({ id: 'msg-xyz', attachments: [{ name: 'a.pdf', mime: 'application/pdf', size: 10, path: '/tmp/a.pdf' }] });
  const none = buildTemplateVars({ message, accountLabel: 'Gmail', replyMode: 'none' });
  assert.equal(none.replyInstructions, '');
  assert.ok(none.text.includes('Dobry den'));
  assert.ok(none.attachments.includes('/tmp/a.pdf'));

  const draft = buildTemplateVars({ message, accountLabel: 'Gmail', replyMode: 'draft' });
  assert.ok(draft.replyInstructions.includes('msg-xyz'));
  assert.ok(draft.replyInstructions.includes('cloudcli-channels'));
  assert.ok(draft.replyInstructions.includes('schválení'));

  const rendered = renderPromptTemplate(DEFAULT_PROMPT_TEMPLATE, draft);
  assert.ok(rendered.startsWith('Přišla nová zpráva přes E-mail (účet Gmail).'));
  assert.ok(rendered.includes('Od: Jan Novak <jan@firma.cz>'));
});

test('senderMatches: exact, domain, glob and wildcard', () => {
  const email = makeMessage({ from: { address: 'Jan@Firma.cz' } });
  assert.ok(senderMatches('jan@firma.cz', email));
  assert.ok(senderMatches('@firma.cz', email));
  assert.ok(!senderMatches('@jina.cz', email));
  assert.ok(senderMatches('*', email));

  const phone = makeMessage({ channel: 'whatsapp', from: { address: '+420777123456' } });
  assert.ok(senderMatches('+420*', phone));
  assert.ok(senderMatches('+420 777 123 456', phone));
  assert.ok(!senderMatches('+421*', phone));
});

function rule(overrides: Partial<ChannelRuleRow>): ChannelRuleRow {
  return {
    id: overrides.id ?? Math.random().toString(16).slice(2),
    name: 'r', enabled: 1, position: 1, account_id: null, channel: null, conditions: '{}',
    project_path: '/p', provider: 'claude', model: null, effort: null, permission_mode: 'default',
    prompt_template: '', conversation: 'thread', reply_mode: 'none', reply_scope: 'sender', owner_user_id: null,
    created_at: '', updated_at: '',
    ...overrides,
  };
}

const account: ChannelAccountRow = {
  id: 'acc-1', type: 'email', label: 'Gmail', enabled: 1, config: '{}', secrets: '{}', agent_send: 'off',
  status: 'connected', status_detail: null, last_seen_at: null, created_at: '', updated_at: '',
};

test('findMatchingRule honours conditions, filters and order', () => {
  const message = makeMessage({ subject: 'URGENT: faktura', text: 'prosím o kontrolu', attachments: [] });

  const excluded = rule({ id: 'excluded', position: 1, conditions: JSON.stringify({ senders: ['@firma.cz'], excludeSenders: ['jan@firma.cz'] }) });
  const otherAccount = rule({ id: 'other-account', position: 2, account_id: 'acc-2' });
  const otherChannel = rule({ id: 'other-channel', position: 3, channel: 'whatsapp' });
  const disabled = rule({ id: 'disabled', position: 4, enabled: 0 });
  const needsAttachment = rule({ id: 'attachment', position: 5, conditions: JSON.stringify({ hasAttachments: true }) });
  const group = rule({ id: 'group', position: 6, conditions: JSON.stringify({ isGroup: true }) });
  const subjectRegex = rule({ id: 'regex', position: 8, conditions: JSON.stringify({ subject: { regex: '^urgent' }, text: { contains: ['KONTROLU'] } }) });
  const catchAll = rule({ id: 'catch-all', position: 7 });

  assert.equal(findMatchingRule([catchAll, subjectRegex, group, needsAttachment, disabled, otherChannel, otherAccount, excluded], message, account)?.id, 'catch-all');
  assert.equal(findMatchingRule([subjectRegex], message, account)?.id, 'regex');
  assert.equal(findMatchingRule([subjectRegex], makeMessage({ subject: 'nic' }), account), null);
  assert.equal(findMatchingRule([excluded], makeMessage({ from: { address: 'petr@firma.cz' } }), account)?.id, 'excluded');
});

test('validateRuleInput refuses autonomy without a sender filter', () => {
  assert.throws(
    () => validateRuleInput({ name: 'x', conditions: {}, projectPath: '/p', provider: 'claude', permissionMode: 'bypassPermissions' }),
    (error: unknown) => (error as { code?: string }).code === 'RULE_OPEN_AUTONOMY',
  );
  assert.throws(
    () => validateRuleInput({ name: 'x', conditions: { senders: ['*'] }, projectPath: '/p', provider: 'claude', replyMode: 'auto' }),
    (error: unknown) => (error as { code?: string }).code === 'RULE_OPEN_AUTONOMY',
  );
  assert.throws(
    () => validateRuleInput({ name: 'x', conditions: { subject: { regex: '(' } }, projectPath: '/p', provider: 'claude' }),
    (error: unknown) => (error as { code?: string }).code === 'RULE_INVALID_REGEX',
  );
  validateRuleInput({ name: 'x', conditions: {}, projectPath: '/p', provider: 'claude', replyMode: 'draft' });
  validateRuleInput({ name: 'x', conditions: { senders: ['jan@firma.cz'] }, projectPath: '/p', provider: 'claude', permissionMode: 'bypassPermissions', replyMode: 'auto' });
});

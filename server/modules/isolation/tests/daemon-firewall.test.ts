import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFirewallRules, renderHostsFile } from '../daemon/firewall.js';

const opts = { proxyPort: 7702, forwardPort: 7701 };
const projects = [
  { uid: 20001, tcp: [{ ip: '203.0.113.7', port: 993 }, { ip: '2001:db8::1', port: 993 }] },
  { uid: 20002, tcp: [] },
];

test('firewall rules snapshot (ipv4)', () => {
  assert.deepEqual(buildFirewallRules(projects, opts), [
    '*filter',
    ':CLOUDCLI_SANDBOX - [0:0]',
    '-F CLOUDCLI_SANDBOX',
    '-A CLOUDCLI_SANDBOX -m owner --uid-owner 20001 -o lo -p tcp --dport 7701 -j ACCEPT',
    '-A CLOUDCLI_SANDBOX -m owner --uid-owner 20001 -o lo -p tcp --dport 7702 -j ACCEPT',
    '-A CLOUDCLI_SANDBOX -m owner --uid-owner 20001 -d 203.0.113.7 -p tcp --dport 993 -j ACCEPT',
    '-A CLOUDCLI_SANDBOX -m owner --uid-owner 20001 -j DROP',
    '-A CLOUDCLI_SANDBOX -m owner --uid-owner 20002 -o lo -p tcp --dport 7701 -j ACCEPT',
    '-A CLOUDCLI_SANDBOX -m owner --uid-owner 20002 -o lo -p tcp --dport 7702 -j ACCEPT',
    '-A CLOUDCLI_SANDBOX -m owner --uid-owner 20002 -j DROP',
    '-A CLOUDCLI_SANDBOX -m owner --uid-owner 20000-4294967294 -j DROP',
    'COMMIT',
  ]);
});

test('uid isolation: no cross-project accepts, DNS dropped, root untouched', () => {
  const rules = buildFirewallRules(projects, opts);
  assert.ok(!rules.some((r) => r.includes('uid-owner 20002') && r.includes('203.0.113.7')));
  assert.ok(!rules.some((r) => /dport 53/.test(r) && r.includes('ACCEPT')));
  assert.ok(rules.every((r) => !r.startsWith('-A') || /--uid-owner (2000[12]|20000-4294967294)/.test(r)));
  assert.ok(!rules.some((r) => /uid-owner 0\b/.test(r)));
  // ipv6 variant only carries ipv6 targets
  const v6 = buildFirewallRules(projects, { ...opts, family: 6 });
  assert.ok(v6.some((r) => r.includes('2001:db8::1')));
  assert.ok(!v6.some((r) => r.includes('203.0.113.7')));
});

test('rules are idempotent and refuse low uids', () => {
  assert.deepEqual(buildFirewallRules(projects, opts), buildFirewallRules(projects, opts));
  assert.throws(() => buildFirewallRules([{ uid: 0, tcp: [] }], opts));
  assert.throws(() => buildFirewallRules([{ uid: 1000, tcp: [] }], opts));
});

test('hosts block is replaced, not duplicated', () => {
  const base = '127.0.0.1 localhost\n';
  const once = renderHostsFile(base, [{ ip: '203.0.113.7', host: 'imap.example' }]);
  const twice = renderHostsFile(once, [{ ip: '203.0.113.8', host: 'imap.example' }]);
  assert.equal(twice.match(/BEGIN cloudcli-sandbox/g)?.length, 1);
  assert.ok(twice.includes('203.0.113.8 imap.example') && !twice.includes('203.0.113.7'));
  assert.equal(renderHostsFile(twice, []), base);
});

test('uid without a pushed config only gets the catch-all DROP (both families)', () => {
  for (const family of [4, 6] as const) {
    const rules = buildFirewallRules([], { ...opts, family });
    assert.deepEqual(rules, [
      '*filter',
      ':CLOUDCLI_SANDBOX - [0:0]',
      '-F CLOUDCLI_SANDBOX',
      '-A CLOUDCLI_SANDBOX -m owner --uid-owner 20000-4294967294 -j DROP',
      'COMMIT',
    ]);
  }
  const rules = buildFirewallRules(projects, opts);
  assert.equal(rules.at(-2), '-A CLOUDCLI_SANDBOX -m owner --uid-owner 20000-4294967294 -j DROP');
});

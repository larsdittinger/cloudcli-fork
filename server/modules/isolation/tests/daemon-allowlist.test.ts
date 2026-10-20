import assert from 'node:assert/strict';
import test from 'node:test';

import { isHttpAllowed, parseAllowlist } from '../daemon/allowlist.js';

const allowed = (lines: string[], host: string, port: number) => isHttpAllowed(parseAllowlist(lines).entries, host, port);

test('allowlist matcher', () => {
  const table: Array<[string[], string, number, boolean]> = [
    [['ethia.cz'], 'ethia.cz', 443, true],
    [['ethia.cz'], 'ethia.cz', 80, true],
    [['ethia.cz'], 'ETHIA.CZ.', 443, true],
    [['ethia.cz'], 'ethia.cz.evil.com', 443, false],
    [['ethia.cz'], 'evilethia.cz', 443, false],
    [['ethia.cz'], 'www.ethia.cz', 443, false],
    [['ethia.cz'], 'ethia.cz', 8443, false],
    [['*.ethia.cz'], 'www.ethia.cz', 443, true],
    [['*.ethia.cz'], 'a.b.ethia.cz', 443, true],
    [['*.ethia.cz'], 'ethia.cz', 443, false],
    [['*.ethia.cz'], 'evilethia.cz', 443, false],
    [['imap.nameserver.sk:993'], 'imap.nameserver.sk', 993, false], // tcp entries are not HTTP
    [['ethia.cz'], '1.2.3.4', 443, false],
    [['bücher.example'], 'xn--bcher-kva.example', 443, true],
    [['xn--bcher-kva.example'], 'BÜCHER.example.', 443, true],
  ];
  for (const [lines, host, port, expected] of table) {
    assert.equal(allowed(lines, host, port), expected, `${lines} ${host}:${port}`);
  }
});

test('parseAllowlist entries and errors', () => {
  const { entries, errors } = parseAllowlist([
    '',
    '# comment',
    '  Ethia.CZ.  ',
    '*.Example.com',
    'imap.nameserver.sk:993',
    '10.0.0.5:5432',
    '1.2.3.4',
    '*.1.2.3.4',
    'host:99999',
    'bad host',
    '*.x.com:80',
  ]);
  assert.deepEqual(entries, [
    { kind: 'domain', host: 'ethia.cz', wildcard: false },
    { kind: 'domain', host: 'example.com', wildcard: true },
    { kind: 'tcp', host: 'imap.nameserver.sk', port: 993 },
    { kind: 'tcp', host: '10.0.0.5', port: 5432 },
  ]);
  assert.deepEqual(errors.map((e) => e.line), [7, 8, 9, 10, 11]);
  assert.match(errors[0].message, /name/);
});

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { inlineCodeFileRef } from '@/modules/chat/utils/inlineFileReference';

/**
 * Agents name the files they produced in `inline code`. Those spans become
 * links to the file — but only spans that could be a file path are even
 * checked against the project, so prose in backticks stays plain.
 */

test('paths and bare filenames are candidates', () => {
  assert.equal(inlineCodeFileRef('vystup/krabice_fs56/rukav_FS56_final_velky.pdf'), 'vystup/krabice_fs56/rukav_FS56_final_velky.pdf');
  assert.equal(inlineCodeFileRef('rukav_FS56_final_ROLAND_zkouska_3_velikosti.pdf'), 'rukav_FS56_final_ROLAND_zkouska_3_velikosti.pdf');
  assert.equal(inlineCodeFileRef('./src/index.ts'), './src/index.ts');
  assert.equal(inlineCodeFileRef('/workspace/etikety/README.md'), '/workspace/etikety/README.md');
  assert.equal(inlineCodeFileRef('.env'), '.env');
  assert.equal(inlineCodeFileRef(' package.json '), 'package.json');
});

test('a line suffix is stripped from the path to open', () => {
  assert.equal(inlineCodeFileRef('src/foo.ts:130'), 'src/foo.ts');
  assert.equal(inlineCodeFileRef('src/foo.ts:130:7'), 'src/foo.ts');
});

test('prose, commands, urls and numbers are not candidates', () => {
  for (const text of [
    'CutContour',
    'npm run test',
    'https://cloudcli.ethia.cz/x.pdf',
    'v1.2',
    '0.5',
    '1.25',
    'foo()',
    'obj.method()',
    '--dry-run',
    'a,b.txt',
    'src/',
    '',
    'file name.pdf',
    `${'a/'.repeat(200)}x.pdf`,
  ]) {
    assert.equal(inlineCodeFileRef(text), null, text);
  }
});

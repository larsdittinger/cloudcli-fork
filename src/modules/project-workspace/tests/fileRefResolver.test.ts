import assert from 'node:assert/strict';

import { test } from 'vitest';

import { createFileRefResolver } from '@/modules/project-workspace/utils/fileRefResolver';

/**
 * Chat turns `inline code` into a file link only when the file exists. The
 * project tree answers bare names; the server answers exact paths the tree
 * leaves out (gitignored, dist/, build/ …), batched into one request.
 */

const tree = (paths: string[]) => paths.map((p) => ({ name: p.split('/').pop() as string, path: p }));

function setup(initialTree: string[], onDisk: string[] = []) {
  let files = tree(initialTree);
  let now = 0;
  const listCalls: number[] = [];
  const existsCalls: string[][] = [];
  const resolver = createFileRefResolver({
    listFiles: async () => {
      listCalls.push(now);
      return files;
    },
    filesExist: async (paths) => {
      existsCalls.push(paths);
      return paths.filter((p) => onDisk.includes(p));
    },
    now: () => now,
    batchDelayMs: 0,
  });
  return {
    resolver,
    listCalls,
    existsCalls,
    setTree: (paths: string[]) => { files = tree(paths); },
    advance: (ms: number) => { now += ms; },
  };
}

test('a bare name or partial path resolves to the project file', async () => {
  const { resolver } = setup(['/w/p/vystup/krabice/velky.pdf', '/w/p/README.md']);
  assert.equal(await resolver.resolve('velky.pdf'), '/w/p/vystup/krabice/velky.pdf');
  assert.equal(await resolver.resolve('krabice/velky.pdf'), '/w/p/vystup/krabice/velky.pdf');
  assert.equal(await resolver.resolve('./README.md'), '/w/p/README.md');
});

test('paths missing from the tree are checked on the server in one batch', async () => {
  const { resolver, existsCalls } = setup(['/w/p/README.md'], ['dist/report.pdf']);
  const [a, b] = await Promise.all([
    resolver.resolve('dist/report.pdf'),
    resolver.resolve('nope/missing.pdf'),
  ]);
  assert.equal(a, 'dist/report.pdf');
  assert.equal(b, null);
  assert.deepEqual(existsCalls, [['dist/report.pdf', 'nope/missing.pdf']]);
});

test('answers are cached', async () => {
  const { resolver, existsCalls, listCalls } = setup(['/w/p/a.pdf'], ['b.pdf']);
  await resolver.resolve('a.pdf');
  await resolver.resolve('b.pdf');
  await resolver.resolve('a.pdf');
  await resolver.resolve('b.pdf');
  assert.equal(listCalls.length, 1);
  assert.equal(existsCalls.length, 1);
});

test('a file the agent created after the tree loaded is found after a refresh', async () => {
  const t = setup(['/w/p/old.pdf']);
  assert.equal(await t.resolver.resolve('old.pdf'), '/w/p/old.pdf');
  t.setTree(['/w/p/old.pdf', '/w/p/out/new.pdf']);
  t.advance(30_000);
  assert.equal(await t.resolver.resolve('new.pdf'), '/w/p/out/new.pdf');
  assert.equal(t.listCalls.length, 2);
});

test('misses do not refetch the tree more than once per throttle window', async () => {
  const t = setup(['/w/p/a.pdf']);
  await t.resolver.resolve('a.pdf');
  t.advance(1_000);
  await t.resolver.resolve('x.pdf');
  await t.resolver.resolve('y.pdf');
  assert.equal(t.listCalls.length, 1);
});

test('a miss is forgotten after a while so a later render can find the file', async () => {
  const t = setup([]);
  assert.equal(await t.resolver.resolve('later.pdf'), null);
  t.setTree(['/w/p/later.pdf']);
  t.advance(30_000);
  assert.equal(await t.resolver.resolve('later.pdf'), '/w/p/later.pdf');
});

test('the tree match used for opening never calls the server', async () => {
  const { resolver, existsCalls } = setup(['/w/p/a.pdf']);
  assert.equal(await resolver.match('a.pdf'), '/w/p/a.pdf');
  assert.equal(await resolver.match('zzz.pdf'), null);
  assert.equal(existsCalls.length, 0);
});

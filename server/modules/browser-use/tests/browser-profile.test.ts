import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { resolveProfileDir, clearStaleProfileLock, DEFAULT_PROFILE_NAME } from '@/modules/browser-use/browser-profile.js';

const ROOT = '/tmp/profiles';
const makeTempDir = () => '/tmp/ephemeral-XYZ';

test('bez profilu jede sdileny default', () => {
  const r = resolveProfileDir({ profileName: null, profileRoot: ROOT, inUse: new Set(), makeTempDir });
  assert.equal(r.dir, path.join(ROOT, DEFAULT_PROFILE_NAME));
  assert.equal(r.ephemeral, false);
});

test('pojmenovany profil se sanitizuje', () => {
  const r = resolveProfileDir({ profileName: 'Google Ads!', profileRoot: ROOT, inUse: new Set(), makeTempDir });
  assert.equal(r.dir, path.join(ROOT, 'google-ads'));
});

test('obsazeny dir spadne na temp bez persistence', () => {
  const inUse = new Set([path.join(ROOT, DEFAULT_PROFILE_NAME)]);
  const r = resolveProfileDir({ profileName: null, profileRoot: ROOT, inUse, makeTempDir });
  assert.equal(r.dir, '/tmp/ephemeral-XYZ');
  assert.equal(r.ephemeral, true);
});

function profileWithLock(target: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-lock-test-'));
  fs.symlinkSync(target, path.join(dir, 'SingletonLock'));
  fs.symlinkSync('123', path.join(dir, 'SingletonCookie'));
  fs.symlinkSync('/tmp/nonexistent/SingletonSocket', path.join(dir, 'SingletonSocket'));
  return dir;
}

const singletons = (dir: string) => fs.readdirSync(dir).filter((f) => f.startsWith('Singleton'));

test('zamek z jineho hostu (predchozi kontejner) se smaze', () => {
  const dir = profileWithLock('6497d4d9e49d-437');
  assert.equal(clearStaleProfileLock(dir, { hostname: '91f8274defe6', isAlive: () => true }), true);
  assert.deepEqual(singletons(dir), []);
});

test('zamek mrtveho procesu na stejnem hostu se smaze', () => {
  const dir = profileWithLock('myhost-437');
  assert.equal(clearStaleProfileLock(dir, { hostname: 'myhost', isAlive: () => false }), true);
  assert.deepEqual(singletons(dir), []);
});

test('zamek zijiciho procesu na stejnem hostu zustane', () => {
  const dir = profileWithLock('myhost-437');
  assert.equal(clearStaleProfileLock(dir, { hostname: 'myhost', isAlive: () => true }), false);
  assert.equal(singletons(dir).length, 3);
});

test('profil bez zamku nic nedela', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-lock-test-'));
  assert.equal(clearStaleProfileLock(dir, { hostname: 'myhost', isAlive: () => true }), false);
});

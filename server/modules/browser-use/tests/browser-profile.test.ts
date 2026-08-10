import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { resolveProfileDir, DEFAULT_PROFILE_NAME } from '@/modules/browser-use/browser-profile.js';

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

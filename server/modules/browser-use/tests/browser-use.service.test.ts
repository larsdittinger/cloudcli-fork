import assert from 'node:assert/strict';
import test from 'node:test';

import { browserUseService, __testables } from '@/modules/browser-use/browser-use.service.js';
import { defaultEmulation } from '@/modules/browser-use/browser-emulation.js';

test('browser monitor list starts empty without agent sessions', async () => {
  const sessions = await browserUseService.listSessions();

  assert.deepEqual(sessions, []);
});

test('selhani launche neponecha neefemerni profil v profileDirsInUse', async () => {
  const { launchEmulatedContext, profileDirsInUse } = __testables;
  const profileName = 'leak-guard-profile';
  const failingPlaywright = {
    chromium: {
      launchPersistentContext: async () => {
        throw new Error('launch selhal (chybi Chrome kanal)');
      },
    },
  };

  const sizeBefore = profileDirsInUse.size;
  await assert.rejects(
    () => launchEmulatedContext(failingPlaywright, defaultEmulation(), profileName),
    /launch selhal/,
  );

  const zbylProfil = [...profileDirsInUse].some((dir) => dir.includes(profileName));
  assert.equal(zbylProfil, false, 'neefemerni profil nesmi zustat drzeny po selhani launche');
  assert.equal(profileDirsInUse.size, sizeBefore, 'set profilu se musi vratit do puvodniho stavu');
});

test('findChromeExecutable: preferuje /opt/google/chrome/chrome', () => {
  const { findChromeExecutable } = __testables;
  const existsSync = (candidate: string) => candidate === '/opt/google/chrome/chrome';
  const which = () => null;

  assert.equal(findChromeExecutable(existsSync, which), '/opt/google/chrome/chrome');
});

test('findChromeExecutable: fallback na which google-chrome-stable', () => {
  const { findChromeExecutable } = __testables;
  const existsSync = () => false;
  const which = (bin: string) => (bin === 'google-chrome-stable' ? '/usr/bin/google-chrome-stable' : null);

  assert.equal(findChromeExecutable(existsSync, which), '/usr/bin/google-chrome-stable');
});

test('findChromeExecutable: bez Chrome vrati null (macOS dev)', () => {
  const { findChromeExecutable } = __testables;

  assert.equal(findChromeExecutable(() => false, () => null), null);
});

test('launchEmulatedContext: SingletonLock relaunch se zkusi znovu a projde', async () => {
  const { launchEmulatedContext, profileDirsInUse } = __testables;
  const profileName = 'singleton-retry-profile';
  const page = { on() {}, url: () => 'about:blank' };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    addInitScript: async () => undefined,
    on() {},
    off() {},
  };

  let calls = 0;
  const flakyPlaywright = {
    chromium: {
      launchPersistentContext: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('Failed to create a ProcessSingleton for your profile directory.');
        }
        return context;
      },
    },
  };

  const handle = await launchEmulatedContext(flakyPlaywright, defaultEmulation(), profileName);
  try {
    assert.equal(calls, 2, 'launch se ma po SingletonLock zkusit jeste jednou');
    assert.equal(handle.context, context, 'druhy pokus ma vratit zivy kontext');
  } finally {
    if (handle.profileDir) {
      profileDirsInUse.delete(handle.profileDir);
    }
  }
});

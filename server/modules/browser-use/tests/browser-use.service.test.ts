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

// ethia fork: TTL uklid bezel jen liene (pri dalsim requestu). Kdyz agent
// dobehl, Chrome zustal viset donekonecna a snedl pamet kontejneru — proto
// periodicky reaper.
test('reaper tick zavre session, ktera prekrocila TTL, i bez dalsiho requestu', async () => {
  const { sessions, reaperTick, sessionTtlMs } = __testables;
  const id = 'ttl-reaper-session';
  const davno = new Date(Date.now() - sessionTtlMs - 60_000).toISOString();
  sessions.set(id, {
    id,
    ownerId: 'agent',
    createdBy: 'agent',
    status: 'ready',
    url: null,
    title: null,
    screenshotDataUrl: null,
    createdAt: davno,
    updatedAt: davno,
    lastAction: 'navigate',
    message: null,
    profileName: null,
    viewport: { width: 1280, height: 800 },
    emulation: defaultEmulation(),
    cursor: null,
  } as never);

  try {
    await reaperTick();

    const session = sessions.get(id) as { status: string; lastAction: string } | undefined;
    assert.equal(session?.status, 'stopped', 'prosla session musi byt zavrena bez dalsiho requestu');
    assert.equal(session?.lastAction, 'expire');
  } finally {
    sessions.delete(id);
  }
});

test('reaper se spusti se session a zase zhasne, kdyz zadna ready session nezbyva', async () => {
  const { sessions, ensureSessionReaper, reaperTick, isReaperRunning } = __testables;
  const id = 'reaper-lifecycle-session';
  const davno = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  assert.equal(isReaperRunning(), false, 'bez sessions reaper netika');

  sessions.set(id, {
    id,
    ownerId: 'agent',
    createdBy: 'agent',
    status: 'ready',
    url: null,
    title: null,
    screenshotDataUrl: null,
    createdAt: davno,
    updatedAt: davno,
    lastAction: 'create',
    message: null,
    profileName: null,
    viewport: { width: 1280, height: 800 },
    emulation: defaultEmulation(),
    cursor: null,
  } as never);

  try {
    ensureSessionReaper();
    assert.equal(isReaperRunning(), true, 'se ready session ma reaper bezet');

    await reaperTick();
    assert.equal(isReaperRunning(), false, 'po uklidu posledni session se timer zastavi');
  } finally {
    sessions.delete(id);
  }
});

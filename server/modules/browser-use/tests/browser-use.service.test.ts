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

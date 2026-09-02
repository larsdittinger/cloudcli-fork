import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldExpireSession } from './authSessionPolicy';

const STORED = 'header.stored-payload.signature';
const OLDER = 'header.older-payload.signature';

test('a rejected request that carried the stored token ends the session', () => {
  assert.equal(shouldExpireSession(true, STORED, STORED), true);
});

test('a rejected request sent without a token leaves the session alone', () => {
  // A provider mounted above the auth gate fetches before login; its 401 must
  // not clear a token stored while the request was in flight.
  assert.equal(shouldExpireSession(true, null, STORED), false);
  assert.equal(shouldExpireSession(true, null, null), false);
});

test('a rejected request carrying a superseded token leaves the session alone', () => {
  // Sent before login, answered after it — the stored token is now a different one.
  assert.equal(shouldExpireSession(true, OLDER, STORED), false);
});

test('a response without X-Auth-Error never ends the session', () => {
  assert.equal(shouldExpireSession(false, STORED, STORED), false);
});

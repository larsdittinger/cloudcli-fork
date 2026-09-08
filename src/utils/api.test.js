import assert from 'node:assert/strict';
import test from 'node:test';

import { isAuthTokenExpired, isNewerAuthToken, TOKEN_EXPIRY_SKEW_MS } from './api.js';

// Builds a JWT-shaped string (header.payload.signature, base64url segments) without
// needing a real signing library — isAuthTokenExpired() never verifies the signature,
// it only decodes the payload, so the header/signature segments are placeholders.
const makeToken = (payload) => {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
};

test('isAuthTokenExpired: a token well before its exp is not expired', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = makeToken({ iat: now - 60, exp: now + 600 }); // 10 min from now
  assert.equal(isAuthTokenExpired(token), false);
});

test('isAuthTokenExpired: a token expired within the clock-skew tolerance is not treated as expired', () => {
  const now = Math.floor(Date.now() / 1000);
  const skewSeconds = TOKEN_EXPIRY_SKEW_MS / 1000;
  const token = makeToken({ iat: now - 600, exp: now - Math.floor(skewSeconds / 2) });
  assert.equal(isAuthTokenExpired(token), false);
});

test('isAuthTokenExpired: a token expired just past the clock-skew tolerance is expired', () => {
  const now = Math.floor(Date.now() / 1000);
  const skewSeconds = TOKEN_EXPIRY_SKEW_MS / 1000;
  const token = makeToken({ iat: now - 600, exp: now - skewSeconds - 5 });
  assert.equal(isAuthTokenExpired(token), true);
});

test('isAuthTokenExpired: a token expired well past the skew tolerance is expired', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = makeToken({ iat: now - 600, exp: now - 600 }); // 10 min ago
  assert.equal(isAuthTokenExpired(token), true);
});

test('isAuthTokenExpired: a malformed/unreadable token is unaffected by the skew change', () => {
  // readTokenClaims() returns null for these, so isAuthTokenExpired() short-circuits
  // to false regardless of TOKEN_EXPIRY_SKEW_MS — behaviour unchanged by this fix.
  assert.equal(isAuthTokenExpired('not-a-jwt'), false);
  assert.equal(isAuthTokenExpired('only.two-segments'), false);
  assert.equal(isAuthTokenExpired(null), false);
});

// isNewerAuthToken() guards X-Refreshed-Token: a 304 revalidation replays cached
// response headers, so the header may carry a token issued long before the current one.
test('isNewerAuthToken: a token issued after the current one is accepted', () => {
  const now = Math.floor(Date.now() / 1000);
  const current = makeToken({ iat: now - 3600, exp: now + 6 * 24 * 3600 });
  const refreshed = makeToken({ iat: now, exp: now + 7 * 24 * 3600 });
  assert.equal(isNewerAuthToken(refreshed, current), true);
});

test('isNewerAuthToken: a token issued before the current one is rejected even if still valid', () => {
  const now = Math.floor(Date.now() / 1000);
  const current = makeToken({ iat: now - 60, exp: now + 7 * 24 * 3600 });
  const stale = makeToken({ iat: now - 3 * 24 * 3600, exp: now + 4 * 24 * 3600 });
  assert.equal(isNewerAuthToken(stale, current), false);
});

test('isNewerAuthToken: an already expired token is rejected regardless of the current one', () => {
  const now = Math.floor(Date.now() / 1000);
  const expired = makeToken({ iat: now - 8 * 24 * 3600, exp: now - 3600 });
  assert.equal(isNewerAuthToken(expired, null), false);
  assert.equal(isNewerAuthToken(expired, makeToken({ iat: now - 9 * 24 * 3600, exp: now + 60 })), false);
});

test('isNewerAuthToken: with no current token any valid, readable token is accepted', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(isNewerAuthToken(makeToken({ iat: now, exp: now + 60 }), null), true);
  assert.equal(isNewerAuthToken('not-a-jwt', null), false);
});

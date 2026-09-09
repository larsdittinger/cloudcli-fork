import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  AUTH_SESSION_EXPIRED_EVENT,
  AUTH_TOKEN_REFRESHED_EVENT,
  getAuthTokenRefreshDelay,
  getStoredAuthToken,
  isAuthTokenExpired,
  isNewerAuthToken,
  shouldExpireSession,
  storeAuthToken,
  TOKEN_EXPIRY_SKEW_MS,
} from '@/shared/authToken';

// Builds a JWT-shaped string (header.payload.signature, base64url segments) without
// needing a real signing library — isAuthTokenExpired() never verifies the signature,
// it only decodes the payload, so the header/signature segments are placeholders.
const makeToken = (payload: Record<string, unknown>) => {
  const encode = (value: unknown) =>
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

test('storeAuthToken: a valid token is persisted and announced to the app', () => {
  localStorage.clear();
  const now = Math.floor(Date.now() / 1000);
  const token = makeToken({ iat: now, exp: now + 600 });

  let announced: string | null = null;
  const onRefresh = (event: Event) => {
    announced = (event as CustomEvent<string>).detail;
  };
  window.addEventListener(AUTH_TOKEN_REFRESHED_EVENT, onRefresh);

  const stored = storeAuthToken(token);

  window.removeEventListener(AUTH_TOKEN_REFRESHED_EVENT, onRefresh);
  assert.equal(stored, true);
  assert.equal(localStorage.getItem('auth-token'), token);
  assert.equal(announced, token);
});

test('storeAuthToken: a non-token value is rejected and does not overwrite the session', () => {
  localStorage.clear();
  localStorage.setItem('auth-token', 'existing');

  assert.equal(storeAuthToken(undefined), false);
  assert.equal(storeAuthToken(''), false);
  assert.equal(storeAuthToken({ token: 'x' }), false);
  assert.equal(localStorage.getItem('auth-token'), 'existing');
});

test('getStoredAuthToken: an expired token is dropped and the expiry is announced once', () => {
  localStorage.clear();
  const now = Math.floor(Date.now() / 1000);
  localStorage.setItem('auth-token', makeToken({ iat: now - 7200, exp: now - 3600 }));

  let expiries = 0;
  const onExpired = () => {
    expiries += 1;
  };
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, onExpired);

  const token = getStoredAuthToken();

  window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, onExpired);
  assert.equal(token, null, 'an expired token must not be handed to a request');
  assert.equal(localStorage.getItem('auth-token'), null);
  assert.equal(expiries, 1);
});

test('getStoredAuthToken: a live token is returned and left in storage', () => {
  localStorage.clear();
  const now = Math.floor(Date.now() / 1000);
  const token = makeToken({ iat: now, exp: now + 600 });
  localStorage.setItem('auth-token', token);

  assert.equal(getStoredAuthToken(), token);
  assert.equal(localStorage.getItem('auth-token'), token);
});

test('getAuthTokenRefreshDelay: refresh is scheduled at the halfway point of the lifetime', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = makeToken({ iat: now, exp: now + 600 }); // halfway = +300s

  const delay = getAuthTokenRefreshDelay(token);
  assert.ok(delay !== null);
  assert.ok(Math.abs(delay - 300_000) < 2_000, `expected ~300000ms, got ${delay}`);
});

test('getAuthTokenRefreshDelay: an already-past refresh point schedules immediately, never negative', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(getAuthTokenRefreshDelay(makeToken({ iat: now - 600, exp: now - 300 })), 0);
});

test('getAuthTokenRefreshDelay: an unreadable token schedules nothing', () => {
  // null means "no refresh timer", which is distinct from 0 ("refresh now").
  assert.equal(getAuthTokenRefreshDelay('not-a-jwt'), null);
  assert.equal(getAuthTokenRefreshDelay(null), null);
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

// shouldExpireSession(): only a refused request that carried the token still in
// storage says anything about the session held right now.
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

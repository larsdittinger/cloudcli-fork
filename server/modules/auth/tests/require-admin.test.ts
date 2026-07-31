import assert from 'node:assert/strict';
import test from 'node:test';

import { requireAdmin } from '@/modules/auth/auth.middleware.js';

type FakeResponse = {
  statusCode: number | null;
  body: unknown;
  status(code: number): FakeResponse;
  json(payload: unknown): FakeResponse;
};

function createFakeResponse(): FakeResponse {
  return {
    statusCode: null,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

test('requireAdmin passes admin users through', () => {
  const res = createFakeResponse();
  let nextCalled = false;
  requireAdmin({ user: { id: 1, username: 'boss', role: 'admin' } }, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('requireAdmin rejects restricted users with 403', () => {
  const res = createFakeResponse();
  let nextCalled = false;
  requireAdmin({ user: { id: 2, username: 'viewer', role: 'restricted' } }, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Admin access required', code: 'ADMIN_REQUIRED' });
});

test('requireAdmin allows users without a role (platform mode / legacy)', () => {
  const res = createFakeResponse();
  let nextCalled = false;
  requireAdmin({ user: { id: 3, username: 'platform-user' } }, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

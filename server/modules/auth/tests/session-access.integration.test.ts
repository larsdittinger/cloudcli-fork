/**
 * Per-session access control for restricted users.
 *
 * Project grants decide which projects a restricted user sees; this decides
 * which chats inside them are theirs.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertSessionAccess, canAccessSession, resolveSessionOwnerScope } from '@/modules/auth/index.js';
import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-access-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const admin = { id: 1, role: 'admin' as const };
const restricted = { id: 7, role: 'restricted' as const };
const otherRestricted = { id: 9, role: 'restricted' as const };

test('resolveSessionOwnerScope returns null for admins and platform-mode users', () => {
  assert.equal(resolveSessionOwnerScope(admin), null);
  assert.equal(resolveSessionOwnerScope({ id: 1 }), null);
  assert.equal(resolveSessionOwnerScope(undefined), null);
});

test('resolveSessionOwnerScope scopes a restricted user to their own id', () => {
  assert.equal(resolveSessionOwnerScope(restricted), 7);
  assert.equal(resolveSessionOwnerScope({ id: '7', role: 'restricted' }), 7);
});

test('a restricted user without a usable id is scoped to nothing', () => {
  assert.throws(
    () => resolveSessionOwnerScope({ role: 'restricted' }),
    (error: unknown) => error instanceof AppError && error.statusCode === 403,
  );
});

test('a restricted user reaches their own session only', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('mine-1', 'claude', '/workspace/demo', 'Mine', 7);

    assert.equal(canAccessSession(restricted, 'mine-1'), true);
    assert.equal(canAccessSession(otherRestricted, 'mine-1'), false);
    assert.equal(canAccessSession(admin, 'mine-1'), true);
  });
});

test('a session with no owner is admin-only', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('orphan-1', 'claude', '/workspace/demo');

    assert.equal(canAccessSession(restricted, 'orphan-1'), false);
    assert.equal(canAccessSession(admin, 'orphan-1'), true);
  });
});

test('an unknown session is left to the route handler to report as missing', async () => {
  await withIsolatedDatabase(() => {
    // The composer records a model choice before the session row exists; there
    // is nothing to protect yet, and the handler still answers 404 on reads.
    assert.equal(canAccessSession(restricted, 'not-created-yet'), true);
  });
});

test('assertSessionAccess throws 403 for someone else\'s session', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('theirs-1', 'claude', '/workspace/demo', 'Theirs', 9);

    assert.throws(
      () => assertSessionAccess(restricted, 'theirs-1'),
      (error: unknown) =>
        error instanceof AppError
        && error.statusCode === 403
        && error.code === 'SESSION_ACCESS_DENIED',
    );
    assert.doesNotThrow(() => assertSessionAccess(otherRestricted, 'theirs-1'));
  });
});

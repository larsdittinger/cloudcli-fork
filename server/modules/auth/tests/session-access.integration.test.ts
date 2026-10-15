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

import {
  assertSessionAccess,
  assertSessionRead,
  canAccessProjectPath,
  canAccessSession,
  canReadSession,
  isSessionReadOnlyFor,
  resolveSessionOwnerScope,
} from '@/modules/auth/index.js';
import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionSharesDb,
  sessionsDb,
  userDb,
  userProjectAccessDb,
} from '@/modules/database/index.js';
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

test('resolveSessionOwnerScope accepts the websocket user shape', () => {
  // authenticateWebSocket hands handlers `{ userId, username, role }` — no `id`.
  assert.equal(resolveSessionOwnerScope({ userId: 7, role: 'restricted' }), 7);
  assert.equal(resolveSessionOwnerScope({ userId: '7', role: 'restricted' }), 7);
  assert.equal(resolveSessionOwnerScope({ userId: 1, role: 'admin' }), null);
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

test('canAccessProjectPath follows project grants, also below the project root', async () => {
  await withIsolatedDatabase(() => {
    userDb.createUser('admin', 'hash');
    const viewer = { id: Number(userDb.createUserWithRole('viewer', 'hash', 'restricted').id), role: 'restricted' as const };
    const granted = projectsDb.createProjectPath('/workspace/granted');
    projectsDb.createProjectPath('/workspace/other');
    userProjectAccessDb.setProjectsForUser(viewer.id, [granted.project!.project_id]);

    assert.equal(canAccessProjectPath(viewer, '/workspace/granted'), true);
    assert.equal(canAccessProjectPath(viewer, '/workspace/granted/sub/dir'), true);
    assert.equal(canAccessProjectPath(viewer, '/workspace/other'), false);
    assert.equal(canAccessProjectPath(viewer, '/somewhere/else'), false);
    assert.equal(canAccessProjectPath(viewer, null), false);
    assert.equal(canAccessProjectPath(admin, null), true);
    assert.equal(canAccessProjectPath(admin, '/workspace/other'), true);
  });
});

// ---------------------------------------------------------------------------
// Read-only viewing: chats an admin shared, and "sees all chats" users.
// ---------------------------------------------------------------------------

function createViewer(username: string): { id: number; role: 'restricted' } {
  return { id: Number(userDb.createUserWithRole(username, 'hash', 'restricted').id), role: 'restricted' };
}

test('a shared chat is readable but not writable for the user it was shared with', async () => {
  await withIsolatedDatabase(() => {
    userDb.createUser('admin', 'hash');
    const viewer = createViewer('viewer');
    const outsider = createViewer('outsider');
    projectsDb.createProjectPath('/workspace/ceo');
    sessionsDb.createAppSession('ceo-1', 'claude', '/workspace/ceo', 'CEO chat', null);
    sessionSharesDb.setUsersForSession('ceo-1', [viewer.id]);

    assert.equal(canReadSession(viewer, 'ceo-1'), true);
    assert.equal(canAccessSession(viewer, 'ceo-1'), false);
    assert.equal(canReadSession(outsider, 'ceo-1'), false);
    assert.doesNotThrow(() => assertSessionRead(viewer, 'ceo-1'));
    assert.throws(
      () => assertSessionRead(outsider, 'ceo-1'),
      (error: unknown) => error instanceof AppError && error.statusCode === 403,
    );
  });
});

test('a "sees all chats" user reads every chat of an assigned project, and only there', async () => {
  await withIsolatedDatabase(() => {
    userDb.createUser('admin', 'hash');
    const viewer = createViewer('viewer');
    const granted = projectsDb.createProjectPath('/workspace/marketing');
    projectsDb.createProjectPath('/workspace/finance');
    userProjectAccessDb.setProjectsForUser(viewer.id, [granted.project!.project_id]);
    sessionsDb.createAppSession('mkt-admin', 'claude', '/workspace/marketing', 'Admin chat', null);
    sessionsDb.createAppSession('fin-admin', 'claude', '/workspace/finance', 'Finance chat', null);

    assert.equal(canReadSession(viewer, 'mkt-admin'), false, 'the flag is off by default');

    userDb.setSeesAllSessions(viewer.id, true);
    assert.equal(canReadSession(viewer, 'mkt-admin'), true);
    assert.equal(canAccessSession(viewer, 'mkt-admin'), false, 'seeing is not writing');
    assert.equal(canReadSession(viewer, 'fin-admin'), false, 'not an assigned project');
  });
});

test('restricted listings include shared chats and, with the flag, all chats of assigned projects', async () => {
  await withIsolatedDatabase(() => {
    userDb.createUser('admin', 'hash');
    const viewer = createViewer('viewer');
    const granted = projectsDb.createProjectPath('/workspace/marketing');
    projectsDb.createProjectPath('/workspace/ceo');
    userProjectAccessDb.setProjectsForUser(viewer.id, [granted.project!.project_id]);
    sessionsDb.createAppSession('own', 'claude', '/workspace/marketing', 'Own', viewer.id);
    sessionsDb.createAppSession('mkt-admin', 'claude', '/workspace/marketing', 'Admin', null);
    sessionsDb.createAppSession('ceo-shared', 'claude', '/workspace/ceo', 'Shared', null);
    sessionsDb.createAppSession('ceo-private', 'claude', '/workspace/ceo', 'Private', null);
    sessionSharesDb.setUsersForSession('ceo-shared', [viewer.id]);

    const ids = (rows: Array<{ session_id: string }>) => rows.map((row) => row.session_id).sort();
    assert.deepEqual(ids(sessionsDb.getSessionsByProjectPath('/workspace/marketing', viewer.id)), ['own']);
    assert.deepEqual(ids(sessionsDb.getSessionsByProjectPath('/workspace/ceo', viewer.id)), ['ceo-shared']);
    assert.equal(sessionsDb.countSessionsByProjectPath('/workspace/ceo', viewer.id), 1);
    assert.deepEqual(ids(sessionsDb.getRecentSessionsPage(10, 0, viewer.id).sessions), ['ceo-shared', 'own']);

    userDb.setSeesAllSessions(viewer.id, true);
    assert.deepEqual(ids(sessionsDb.getSessionsByProjectPath('/workspace/marketing', viewer.id)), ['mkt-admin', 'own']);
    assert.deepEqual(ids(sessionsDb.getSessionsByProjectPath('/workspace/ceo', viewer.id)), ['ceo-shared']);
  });
});

test('isSessionReadOnlyFor marks only other people\'s chats for restricted users', () => {
  assert.equal(isSessionReadOnlyFor(restricted, 7), false);
  assert.equal(isSessionReadOnlyFor(restricted, null), true);
  assert.equal(isSessionReadOnlyFor(restricted, 9), true);
  assert.equal(isSessionReadOnlyFor(admin, 9), false);
});

test('sharing is replaced as a set and disappears with the user', async () => {
  await withIsolatedDatabase(() => {
    userDb.createUser('admin', 'hash');
    const first = createViewer('first');
    const second = createViewer('second');
    sessionsDb.createAppSession('ceo-1', 'claude', '/workspace/ceo', 'CEO chat', null);

    sessionSharesDb.setUsersForSession('ceo-1', [first.id, second.id]);
    assert.deepEqual(sessionSharesDb.listUserIdsForSession('ceo-1'), [first.id, second.id]);
    sessionSharesDb.setUsersForSession('ceo-1', [second.id]);
    assert.deepEqual(sessionSharesDb.listUserIdsForSession('ceo-1'), [second.id]);
    assert.deepEqual(sessionSharesDb.countSharesBySession(['ceo-1', 'other']), new Map([['ceo-1', 1]]));

    userDb.deleteUser(second.id);
    assert.deepEqual(sessionSharesDb.listUserIdsForSession('ceo-1'), []);
  });
});

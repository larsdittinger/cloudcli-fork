/**
 * Session ownership: which user a chat belongs to.
 *
 * Restricted users may only ever see the sessions they started themselves.
 * Sessions without an owner (created before this feature, or started outside
 * the web app through the provider CLI) stay admin-only.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-ownership-'));
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

test('createAppSession records the owner and getSessionOwnerId reads it back', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-1', 'claude', '/workspace/demo', 'Mine', 7);

    assert.equal(sessionsDb.getSessionOwnerId('app-1'), 7);
  });
});

test('sessions discovered on disk have no owner', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('disk-1', 'claude', '/workspace/demo');

    assert.equal(sessionsDb.getSessionOwnerId('disk-1'), null);
  });
});

test('getSessionOwnerId returns undefined for an unknown session', async () => {
  await withIsolatedDatabase(() => {
    assert.equal(sessionsDb.getSessionOwnerId('nope'), undefined);
  });
});

test('the disk synchronizer keeps the owner of an app-created session', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-1', 'claude', '/workspace/demo', 'Mine', 7);
    sessionsDb.assignProviderSessionId('app-1', 'provider-1');

    // Re-indexing the transcript that the provider wrote must not orphan the row.
    sessionsDb.createSession('provider-1', 'claude', '/workspace/demo', 'Mine', undefined, undefined, '/tmp/x.jsonl');

    assert.equal(sessionsDb.getSessionOwnerId('app-1'), 7);
  });
});

// Regression guard on existing merge behavior that ownership now depends on:
// when the watcher wins the race, the duplicate row is merged into the app row,
// which is the one carrying the owner.
test('a transcript indexed before the id mapping does not orphan the session', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-1', 'claude', '/workspace/demo', 'Mine', 7);
    sessionsDb.createSession('provider-1', 'claude', '/workspace/demo', 'Mine', undefined, undefined, '/tmp/x.jsonl');
    sessionsDb.assignProviderSessionId('app-1', 'provider-1');

    assert.equal(sessionsDb.getSessionOwnerId('app-1'), 7);
    assert.equal(sessionsDb.getSessionOwnerId('provider-1'), undefined);
  });
});

test('project session pages are filtered to one owner, paginating over the filtered set', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('mine-1', 'claude', '/workspace/demo', 'Mine 1', 7);
    sessionsDb.createAppSession('theirs-1', 'claude', '/workspace/demo', 'Theirs 1', 9);
    sessionsDb.createAppSession('mine-2', 'claude', '/workspace/demo', 'Mine 2', 7);
    sessionsDb.createSession('orphan-1', 'claude', '/workspace/demo');

    const ownPage = sessionsDb.getSessionsByProjectPathPage('/workspace/demo', 10, 0, 7);
    assert.deepEqual(
      ownPage.map((row) => row.session_id).sort(),
      ['mine-1', 'mine-2'],
    );
    assert.equal(sessionsDb.countSessionsByProjectPath('/workspace/demo', 7), 2);

    // No owner filter (admin) still sees every session in the project.
    assert.equal(sessionsDb.getSessionsByProjectPathPage('/workspace/demo', 10, 0).length, 4);
    assert.equal(sessionsDb.countSessionsByProjectPath('/workspace/demo'), 4);
  });
});

test('getSessionsByProjectPath is filtered to one owner', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('mine-1', 'claude', '/workspace/demo', 'Mine 1', 7);
    sessionsDb.createAppSession('theirs-1', 'claude', '/workspace/demo', 'Theirs 1', 9);

    assert.deepEqual(
      sessionsDb.getSessionsByProjectPath('/workspace/demo', 7).map((row) => row.session_id),
      ['mine-1'],
    );
  });
});

test('the recent conversation feed is filtered to one owner', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('mine-1', 'claude', '/workspace/demo', 'Mine 1', 7);
    sessionsDb.createAppSession('theirs-1', 'claude', '/workspace/demo', 'Theirs 1', 9);
    sessionsDb.createSession('orphan-1', 'claude', '/workspace/demo');

    const ownFeed = sessionsDb.getRecentSessionsPage(20, 0, 7);
    assert.deepEqual(ownFeed.sessions.map((row) => row.session_id), ['mine-1']);
    assert.equal(ownFeed.total, 1);

    assert.equal(sessionsDb.getRecentSessionsPage(20, 0).total, 3);
  });
});

test('archived sessions are filtered to one owner', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('mine-1', 'claude', '/workspace/demo', 'Mine 1', 7);
    sessionsDb.createAppSession('theirs-1', 'claude', '/workspace/demo', 'Theirs 1', 9);
    sessionsDb.updateSessionIsArchived('mine-1', true);
    sessionsDb.updateSessionIsArchived('theirs-1', true);

    assert.deepEqual(
      sessionsDb.getArchivedSessions(7).map((row) => row.session_id),
      ['mine-1'],
    );
    assert.equal(sessionsDb.getArchivedSessions().length, 2);
  });
});

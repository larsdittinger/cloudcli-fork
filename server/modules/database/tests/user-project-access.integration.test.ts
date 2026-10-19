import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { apiKeysDb } from '@/modules/database/repositories/api-keys.js';
import { userProjectAccessDb } from '@/modules/database/repositories/user-project-access.js';
import { userDb } from '@/modules/database/repositories/users.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'user-project-access-'));
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

test('migration adds role column defaulting to admin for existing users', async () => {
  await withIsolatedDatabase(() => {
    const created = userDb.createUser('first-user', 'hash');
    const fetched = userDb.getUserById(Number(created.id));
    assert.equal(fetched?.role, 'admin');
  });
});

test('createUserWithRole stores restricted role and listUsers returns it', async () => {
  await withIsolatedDatabase(() => {
    userDb.createUser('admin-user', 'hash');
    const restricted = userDb.createUserWithRole('viewer', 'hash2', 'restricted');
    assert.equal(restricted.role, 'restricted');

    const users = userDb.listUsers();
    assert.equal(users.length, 2);
    assert.deepEqual(
      users.map((user) => [user.username, user.role]),
      [
        ['admin-user', 'admin'],
        ['viewer', 'restricted'],
      ]
    );
  });
});

test('setProjectsForUser replaces grants and canAccess reflects them', async () => {
  await withIsolatedDatabase(() => {
    const user = userDb.createUserWithRole('viewer', 'hash', 'restricted');
    const userId = Number(user.id);

    userProjectAccessDb.setProjectsForUser(userId, ['proj-a', 'proj-b']);
    assert.deepEqual(userProjectAccessDb.listProjectIdsForUser(userId), ['proj-a', 'proj-b']);
    assert.equal(userProjectAccessDb.canAccess(userId, 'proj-a'), true);
    assert.equal(userProjectAccessDb.canAccess(userId, 'proj-c'), false);

    userProjectAccessDb.setProjectsForUser(userId, ['proj-c']);
    assert.deepEqual(userProjectAccessDb.listProjectIdsForUser(userId), ['proj-c']);
    assert.equal(userProjectAccessDb.canAccess(userId, 'proj-a'), false);
  });
});

test('deleteUser cascades user_project_access rows', async () => {
  await withIsolatedDatabase(() => {
    const user = userDb.createUserWithRole('viewer', 'hash', 'restricted');
    const userId = Number(user.id);
    userProjectAccessDb.setProjectsForUser(userId, ['proj-a']);

    userDb.deleteUser(userId);
    assert.deepEqual(userProjectAccessDb.listProjectIdsForUser(userId), []);
  });
});

test('updatePassword changes the stored hash', async () => {
  await withIsolatedDatabase(() => {
    const user = userDb.createUserWithRole('viewer', 'old-hash', 'restricted');
    userDb.updatePassword(Number(user.id), 'new-hash');
    const fetched = userDb.getUserByUsername('viewer');
    assert.equal(fetched?.password_hash, 'new-hash');
  });
});

test('validateApiKey reports the role of the key owner', async () => {
  await withIsolatedDatabase(() => {
    const admin = userDb.createUser('admin-user', 'hash');
    const restricted = userDb.createUserWithRole('viewer', 'hash2', 'restricted');
    const adminKey = apiKeysDb.createApiKey(Number(admin.id), 'admin key').apiKey;
    const restrictedKey = apiKeysDb.createApiKey(Number(restricted.id), 'viewer key').apiKey;

    // The Agent API refuses keys of restricted users, so the role must come along.
    assert.equal(apiKeysDb.validateApiKey(adminKey)?.role, 'admin');
    assert.equal(apiKeysDb.validateApiKey(restrictedKey)?.role, 'restricted');
  });
});

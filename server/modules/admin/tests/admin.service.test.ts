import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminService } from '@/modules/admin/admin.service.js';
import { AppError } from '@/shared/utils.js';

type StoredUser = {
  id: number;
  username: string;
  role: 'admin' | 'restricted';
  created_at: string;
  last_login: string | null;
  passwordHash: string;
};

function createFakeDependencies() {
  const usersById = new Map<number, StoredUser>();
  const grants = new Map<number, string[]>();
  let nextId = 1;

  const dependencies = {
    users: {
      listUsers: () =>
        [...usersById.values()].map(({ passwordHash: _passwordHash, ...user }) => user),
      getUserById: (userId: number) => {
        const user = usersById.get(userId);
        if (!user) return undefined;
        const { passwordHash: _passwordHash, ...publicUser } = user;
        return publicUser;
      },
      createUserWithRole: (
        username: string,
        passwordHash: string,
        role: 'admin' | 'restricted'
      ) => {
        if ([...usersById.values()].some((user) => user.username === username)) {
          const error = new Error('UNIQUE constraint failed') as Error & { code: string };
          error.code = 'SQLITE_CONSTRAINT_UNIQUE';
          throw error;
        }
        const id = nextId;
        nextId += 1;
        usersById.set(id, {
          id,
          username,
          role,
          created_at: '2026-01-01',
          last_login: null,
          passwordHash,
        });
        return { id, username, role };
      },
      deleteUser: (userId: number) => {
        usersById.delete(userId);
        grants.delete(userId);
      },
      updatePassword: (userId: number, passwordHash: string) => {
        const user = usersById.get(userId);
        if (user) user.passwordHash = passwordHash;
      },
    },
    access: {
      listProjectIdsForUser: (userId: number) => grants.get(userId) ?? [],
      setProjectsForUser: (userId: number, projectIds: string[]) => {
        grants.set(userId, [...projectIds]);
      },
    },
    hashPassword: async (password: string) => `hashed:${password}`,
  };

  return { dependencies, usersById, grants };
}

test('createUser creates a restricted user with hashed password', async () => {
  const { dependencies, usersById } = createFakeDependencies();
  const service = createAdminService(dependencies);

  const result = await service.createUser('viewer', 'secret123');
  assert.equal(result.success, true);
  assert.equal(result.user.role, 'restricted');
  assert.equal(usersById.get(Number(result.user.id))?.passwordHash, 'hashed:secret123');
});

test('createUser rejects short credentials and duplicates', async () => {
  const { dependencies } = createFakeDependencies();
  const service = createAdminService(dependencies);

  await assert.rejects(service.createUser('ab', 'secret123'), (error: AppError) => {
    assert.equal(error.statusCode, 400);
    return true;
  });
  await assert.rejects(service.createUser('viewer', 'short'), (error: AppError) => {
    assert.equal(error.statusCode, 400);
    return true;
  });

  await service.createUser('viewer', 'secret123');
  await assert.rejects(service.createUser('viewer', 'secret456'), (error: AppError) => {
    assert.equal(error.statusCode, 409);
    return true;
  });
});

test('deleteUser refuses self-deletion and missing users', async () => {
  const { dependencies } = createFakeDependencies();
  const service = createAdminService(dependencies);
  const created = await service.createUser('viewer', 'secret123');
  const viewerId = Number(created.user.id);

  assert.throws(() => service.deleteUser(viewerId, viewerId), (error: AppError) => {
    assert.equal(error.code, 'ADMIN_CANNOT_DELETE_SELF');
    return true;
  });
  assert.throws(() => service.deleteUser(99, 12345), (error: AppError) => {
    assert.equal(error.statusCode, 404);
    return true;
  });

  const result = service.deleteUser(99, viewerId);
  assert.equal(result.success, true);
  assert.equal(service.listUsers().users.length, 0);
});

test('setProjects validates input and listUsers exposes grants', async () => {
  const { dependencies } = createFakeDependencies();
  const service = createAdminService(dependencies);
  const created = await service.createUser('viewer', 'secret123');
  const viewerId = Number(created.user.id);

  assert.throws(() => service.setProjects(viewerId, 'not-an-array'), (error: AppError) => {
    assert.equal(error.code, 'ADMIN_INVALID_PROJECT_IDS');
    return true;
  });

  service.setProjects(viewerId, ['proj-a', 'proj-b']);
  const { users } = service.listUsers();
  assert.deepEqual(users[0]?.projectIds, ['proj-a', 'proj-b']);
});

test('updatePassword validates and stores a new hash', async () => {
  const { dependencies, usersById } = createFakeDependencies();
  const service = createAdminService(dependencies);
  const created = await service.createUser('viewer', 'secret123');
  const viewerId = Number(created.user.id);

  await assert.rejects(service.updatePassword(viewerId, 'short'), (error: AppError) => {
    assert.equal(error.statusCode, 400);
    return true;
  });

  const result = await service.updatePassword(viewerId, 'newsecret');
  assert.equal(result.success, true);
  assert.equal(usersById.get(viewerId)?.passwordHash, 'hashed:newsecret');
});

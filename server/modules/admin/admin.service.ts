import { AppError } from '@/shared/utils.js';

type AdminUserRecord = {
  id: number;
  username: string;
  role: 'admin' | 'restricted';
  created_at: string;
  last_login: string | null;
};

type AdminDependencies = {
  users: {
    listUsers(): AdminUserRecord[];
    getUserById(userId: number): AdminUserRecord | undefined;
    createUserWithRole(
      username: string,
      passwordHash: string,
      role: 'admin' | 'restricted'
    ): { id: number | bigint; username: string; role: 'admin' | 'restricted' };
    deleteUser(userId: number): void;
    updatePassword(userId: number, passwordHash: string): void;
  };
  access: {
    listProjectIdsForUser(userId: number): string[];
    setProjectsForUser(userId: number, projectIds: string[]): void;
  };
  hashPassword(password: string): Promise<string>;
};

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function requireExistingUser(
  dependencies: AdminDependencies,
  userId: number
): AdminUserRecord {
  const user = dependencies.users.getUserById(userId);
  if (!user) {
    throw new AppError('User not found', { code: 'ADMIN_USER_NOT_FOUND', statusCode: 404 });
  }
  return user;
}

/**
 * Creates the Admin application service for user management. All callers are
 * already admin-guarded at the routing layer.
 */
export function createAdminService(dependencies: AdminDependencies) {
  return {
    listUsers() {
      const users = dependencies.users.listUsers().map((user) => ({
        ...user,
        projectIds: dependencies.access.listProjectIdsForUser(user.id),
      }));
      return { users };
    },

    async createUser(usernameInput: unknown, passwordInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput.trim() : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';

      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }
      if (username.length < 3 || password.length < 6) {
        throw new AppError(
          'Username must be at least 3 characters, password at least 6 characters',
          { code: 'AUTH_CREDENTIALS_TOO_SHORT', statusCode: 400 },
        );
      }

      try {
        const passwordHash = await dependencies.hashPassword(password);
        const user = dependencies.users.createUserWithRole(username, passwordHash, 'restricted');
        return { success: true, user };
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new AppError('Username already exists', {
            code: 'AUTH_USERNAME_CONFLICT',
            statusCode: 409,
          });
        }
        throw error;
      }
    },

    deleteUser(actingUserId: number, targetUserIdInput: unknown) {
      const targetUserId = Number(targetUserIdInput);
      if (!Number.isInteger(targetUserId)) {
        throw new AppError('Invalid user id', { code: 'ADMIN_INVALID_USER_ID', statusCode: 400 });
      }
      if (targetUserId === actingUserId) {
        throw new AppError('You cannot delete your own account', {
          code: 'ADMIN_CANNOT_DELETE_SELF',
          statusCode: 400,
        });
      }
      requireExistingUser(dependencies, targetUserId);
      dependencies.users.deleteUser(targetUserId);
      return { success: true };
    },

    async updatePassword(targetUserIdInput: unknown, passwordInput: unknown) {
      const targetUserId = Number(targetUserIdInput);
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (!Number.isInteger(targetUserId)) {
        throw new AppError('Invalid user id', { code: 'ADMIN_INVALID_USER_ID', statusCode: 400 });
      }
      if (password.length < 6) {
        throw new AppError('Password must be at least 6 characters', {
          code: 'AUTH_CREDENTIALS_TOO_SHORT',
          statusCode: 400,
        });
      }
      requireExistingUser(dependencies, targetUserId);
      dependencies.users.updatePassword(targetUserId, await dependencies.hashPassword(password));
      return { success: true };
    },

    setProjects(targetUserIdInput: unknown, projectIdsInput: unknown) {
      const targetUserId = Number(targetUserIdInput);
      if (!Number.isInteger(targetUserId)) {
        throw new AppError('Invalid user id', { code: 'ADMIN_INVALID_USER_ID', statusCode: 400 });
      }
      if (
        !Array.isArray(projectIdsInput)
        || projectIdsInput.some((projectId) => typeof projectId !== 'string')
      ) {
        throw new AppError('projectIds must be an array of strings', {
          code: 'ADMIN_INVALID_PROJECT_IDS',
          statusCode: 400,
        });
      }
      requireExistingUser(dependencies, targetUserId);
      dependencies.access.setProjectsForUser(targetUserId, projectIdsInput);
      return { success: true, projectIds: projectIdsInput };
    },
  };
}

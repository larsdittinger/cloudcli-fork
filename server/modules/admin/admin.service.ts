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
  /** Read-only viewing of other people's chats: shares and the "sees all chats" flag. */
  viewing: {
    getSeesAllSessions(userId: number): boolean;
    setSeesAllSessions(userId: number, enabled: boolean): void;
    sessionExists(sessionId: string): boolean;
    listUserIdsForSession(sessionId: string): number[];
    setUsersForSession(sessionId: string, userIds: number[]): void;
    listSessionsSharedWithUser(userId: number): Array<{
      session_id: string;
      custom_name: string | null;
      project_path: string | null;
      shared_at: string | null;
    }>;
    /** Pushes the chat to sidebars, so a new viewer sees it without reloading. */
    announceSession(sessionId: string): void;
  };
  hashPassword(password: string): Promise<string>;
};

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function parseUserId(value: unknown): number {
  const userId = Number(value);
  if (!Number.isInteger(userId)) {
    throw new AppError('Invalid user id', { code: 'ADMIN_INVALID_USER_ID', statusCode: 400 });
  }
  return userId;
}

function requireExistingSession(dependencies: AdminDependencies, sessionId: string): void {
  if (!sessionId || !dependencies.viewing.sessionExists(sessionId)) {
    throw new AppError('Session not found', { code: 'ADMIN_SESSION_NOT_FOUND', statusCode: 404 });
  }
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
        seesAllSessions: dependencies.viewing.getSeesAllSessions(user.id),
        sharedSessions: dependencies.viewing.listSessionsSharedWithUser(user.id).map((row) => ({
          sessionId: row.session_id,
          title: row.custom_name,
          projectPath: row.project_path,
          sharedAt: row.shared_at,
        })),
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

    /** Lets a restricted user read every chat of their assigned projects (read-only), or stops it. */
    setSeesAllSessions(targetUserIdInput: unknown, enabledInput: unknown) {
      const targetUserId = parseUserId(targetUserIdInput);
      if (typeof enabledInput !== 'boolean') {
        throw new AppError('enabled must be a boolean', { code: 'ADMIN_INVALID_FLAG', statusCode: 400 });
      }
      requireExistingUser(dependencies, targetUserId);
      dependencies.viewing.setSeesAllSessions(targetUserId, enabledInput);
      return { success: true, enabled: enabledInput };
    },

    getSessionShares(sessionId: string) {
      requireExistingSession(dependencies, sessionId);
      return { userIds: dependencies.viewing.listUserIdsForSession(sessionId) };
    },

    /**
     * Replaces who a chat is shared with. Only restricted users can be named:
     * admins see every chat anyway, and an unknown id is a client bug.
     */
    setSessionShares(sessionId: string, userIdsInput: unknown) {
      requireExistingSession(dependencies, sessionId);
      if (!Array.isArray(userIdsInput) || userIdsInput.some((userId) => !Number.isInteger(userId))) {
        throw new AppError('userIds must be an array of user ids', { code: 'ADMIN_INVALID_USER_IDS', statusCode: 400 });
      }
      const userIds = [...new Set(userIdsInput as number[])];
      for (const userId of userIds) {
        if (dependencies.users.getUserById(userId)?.role !== 'restricted') {
          throw new AppError('Chats can only be shared with restricted users', {
            code: 'ADMIN_INVALID_USER_IDS',
            statusCode: 400,
          });
        }
      }
      dependencies.viewing.setUsersForSession(sessionId, userIds);
      dependencies.viewing.announceSession(sessionId);
      return { success: true, userIds };
    },

    /** Stops sharing one chat with one user (the Users tab's per-chat button). */
    removeSessionShare(sessionId: string, targetUserIdInput: unknown) {
      const targetUserId = parseUserId(targetUserIdInput);
      requireExistingSession(dependencies, sessionId);
      const remaining = dependencies.viewing.listUserIdsForSession(sessionId).filter((userId) => userId !== targetUserId);
      dependencies.viewing.setUsersForSession(sessionId, remaining);
      dependencies.viewing.announceSession(sessionId);
      return { success: true, userIds: remaining };
    },
  };
}

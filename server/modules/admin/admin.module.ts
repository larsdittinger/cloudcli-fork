import { createRequire } from 'node:module';

import { sessionSharesDb, sessionsDb, userDb, userProjectAccessDb } from '@/modules/database/index.js';
import { broadcastSessionUpserted } from '@/modules/websocket/index.js';

import { createAdminRouter } from './admin.routes.js';
import { createAdminService } from './admin.service.js';

type BcryptAdapter = {
  hash(password: string, saltRounds: number): Promise<string>;
};

const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt') as BcryptAdapter;

const adminService = createAdminService({
  users: {
    listUsers: () => userDb.listUsers(),
    getUserById: (userId) => userDb.getUserById(userId),
    createUserWithRole: (username, passwordHash, role) =>
      userDb.createUserWithRole(username, passwordHash, role),
    deleteUser: (userId) => userDb.deleteUser(userId),
    updatePassword: (userId, passwordHash) => userDb.updatePassword(userId, passwordHash),
  },
  access: {
    listProjectIdsForUser: (userId) => userProjectAccessDb.listProjectIdsForUser(userId),
    setProjectsForUser: (userId, projectIds) =>
      userProjectAccessDb.setProjectsForUser(userId, projectIds),
  },
  viewing: {
    getSeesAllSessions: (userId) => userDb.getSeesAllSessions(userId),
    setSeesAllSessions: (userId, enabled) => userDb.setSeesAllSessions(userId, enabled),
    sessionExists: (sessionId) => Boolean(sessionsDb.getSessionById(sessionId)),
    listUserIdsForSession: (sessionId) => sessionSharesDb.listUserIdsForSession(sessionId),
    setUsersForSession: (sessionId, userIds) => sessionSharesDb.setUsersForSession(sessionId, userIds),
    listSessionsSharedWithUser: (userId) => sessionSharesDb.listSessionsSharedWithUser(userId),
    announceSession: (sessionId) => {
      void broadcastSessionUpserted(sessionId).catch((error: unknown) => {
        console.error('[Admin] Failed to announce a shared chat', error);
      });
    },
  },
  // Same cost factor as auth.module.ts so all password hashes are comparable.
  hashPassword: (password) => bcrypt.hash(password, 12),
});

/** Admin router assembled for the server entrypoint. */
export const adminRoutes = createAdminRouter(adminService);

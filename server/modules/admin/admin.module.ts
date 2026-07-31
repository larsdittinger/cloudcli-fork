import { createRequire } from 'node:module';

import { userDb, userProjectAccessDb } from '@/modules/database/index.js';

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
  // Same cost factor as auth.module.ts so all password hashes are comparable.
  hashPassword: (password) => bcrypt.hash(password, 12),
});

/** Admin router assembled for the server entrypoint. */
export const adminRoutes = createAdminRouter(adminService);

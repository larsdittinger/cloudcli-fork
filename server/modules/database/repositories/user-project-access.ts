/**
 * User → project access repository.
 *
 * Maps restricted users to the projects (by project_id) they are allowed
 * to see and chat in. Admin users bypass this table entirely.
 */

import { getConnection } from '@/modules/database/connection.js';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const userProjectAccessDb = {
  /** Returns the project ids the user has been granted access to. */
  listProjectIdsForUser(userId: number): string[] {
    const db = getConnection();
    const rows = db
      .prepare('SELECT project_id FROM user_project_access WHERE user_id = ? ORDER BY project_id')
      .all(userId) as Array<{ project_id: string }>;
    return rows.map((row) => row.project_id);
  },

  /** Replaces the user's project grants with the given set (transactional). */
  setProjectsForUser(userId: number, projectIds: string[]): void {
    const db = getConnection();
    const replaceGrants = db.transaction((ids: string[]) => {
      db.prepare('DELETE FROM user_project_access WHERE user_id = ?').run(userId);
      const insert = db.prepare(
        'INSERT OR IGNORE INTO user_project_access (user_id, project_id) VALUES (?, ?)'
      );
      for (const projectId of ids) {
        insert.run(userId, projectId);
      }
    });
    replaceGrants(projectIds);
  },

  /** Returns true if the user has been granted access to the project. */
  canAccess(userId: number, projectId: string): boolean {
    const db = getConnection();
    const row = db
      .prepare('SELECT 1 FROM user_project_access WHERE user_id = ? AND project_id = ?')
      .get(userId, projectId);
    return row !== undefined;
  },
};

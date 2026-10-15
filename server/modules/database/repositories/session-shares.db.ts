/**
 * Session share repository.
 *
 * Records which restricted users an admin shared a chat with. A share is a
 * read grant only; the visibility rule that uses it lives in
 * `sessions.db.ts` (`viewerScopeClause`), so every session listing honours it.
 */

import { getConnection } from '@/modules/database/connection.js';

type SharedSessionRow = {
  session_id: string;
  custom_name: string | null;
  project_path: string | null;
  shared_at: string | null;
};

export const sessionSharesDb = {
  /** Returns the ids of the users the session is shared with, in id order. */
  listUserIdsForSession(sessionId: string): number[] {
    const db = getConnection();
    const rows = db
      .prepare('SELECT user_id FROM session_shares WHERE session_id = ? ORDER BY user_id')
      .all(sessionId) as Array<{ user_id: number }>;
    return rows.map((row) => row.user_id);
  },

  /** Replaces the set of users the session is shared with (transactional). */
  setUsersForSession(sessionId: string, userIds: number[]): void {
    const db = getConnection();
    const replaceShares = db.transaction((ids: number[]) => {
      db.prepare('DELETE FROM session_shares WHERE session_id = ?').run(sessionId);
      const insert = db.prepare('INSERT OR IGNORE INTO session_shares (session_id, user_id) VALUES (?, ?)');
      for (const userId of ids) {
        insert.run(sessionId, userId);
      }
    });
    replaceShares(userIds);
  },

  /**
   * Counts shares per session for the given ids; sessions without a share are
   * left out of the map. One query per listing page instead of one per row.
   */
  countSharesBySession(sessionIds: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    if (sessionIds.length === 0) {
      return counts;
    }
    const db = getConnection();
    const placeholders = sessionIds.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT session_id, COUNT(*) AS count FROM session_shares
         WHERE session_id IN (${placeholders}) GROUP BY session_id`
      )
      .all(...sessionIds) as Array<{ session_id: string; count: number }>;
    for (const row of rows) {
      counts.set(row.session_id, row.count);
    }
    return counts;
  },

  /** Lists the existing chats shared with a user, newest share first. */
  listSessionsSharedWithUser(userId: number): SharedSessionRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT s.session_id, s.custom_name, s.project_path, sh.shared_at
         FROM session_shares sh
         JOIN sessions s ON s.session_id = sh.session_id
         WHERE sh.user_id = ?
         ORDER BY sh.shared_at DESC, s.session_id`
      )
      .all(userId) as SharedSessionRow[];
  },

  /** Lists the project paths that hold at least one live chat shared with the user. */
  listProjectPathsSharedWithUser(userId: number): string[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT DISTINCT s.project_path
         FROM session_shares sh
         JOIN sessions s ON s.session_id = sh.session_id
         WHERE sh.user_id = ? AND s.isArchived = 0 AND s.project_path IS NOT NULL`
      )
      .all(userId) as Array<{ project_path: string }>;
    return rows.map((row) => row.project_path);
  },
};

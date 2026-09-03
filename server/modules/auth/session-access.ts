/**
 * Per-session access control.
 *
 * `user_project_access` decides which projects a restricted user can open;
 * this module decides which chats inside those projects are theirs. Both the
 * HTTP routes and the chat websocket go through here so a session id cannot be
 * used to read or continue somebody else's conversation.
 */

import { projectsDb, sessionsDb, userProjectAccessDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

export type SessionAccessUser = {
  id?: number | string;
  /**
   * The websocket auth payload carries `userId` instead of `id` (REST hands
   * routes the database row, which has `id`). Both shapes reach this module,
   * so both are accepted.
   */
  userId?: number | string;
  role?: 'admin' | 'restricted' | string;
} | null | undefined;

function isRestricted(user: SessionAccessUser): boolean {
  return user?.role === 'restricted';
}

/**
 * Returns the owner id session queries must be filtered by, or `null` when the
 * caller sees every session (admins, and platform mode where no role is set).
 *
 * Throws for a restricted user whose token carries no usable id: that is a
 * broken session rather than a reason to widen access.
 */
export function resolveSessionOwnerScope(user: SessionAccessUser): number | null {
  if (!isRestricted(user)) {
    return null;
  }

  const ownerUserId = Number(user?.id ?? user?.userId);
  if (!Number.isInteger(ownerUserId)) {
    throw new AppError('Session access denied', {
      code: 'SESSION_ACCESS_DENIED',
      statusCode: 403,
    });
  }

  return ownerUserId;
}

/**
 * Tells whether the user may read or continue one session.
 *
 * A session that does not exist yet is allowed through: the composer records a
 * model or effort choice before the session gateway creates the row, and read
 * routes still answer 404 on their own. A session with no owner belongs to no
 * web user (it predates multi-user, or was started through the provider CLI),
 * so only admins reach it.
 */
export function canAccessSession(user: SessionAccessUser, sessionId: string): boolean {
  const ownerScope = resolveSessionOwnerScope(user);
  if (ownerScope === null) {
    return true;
  }

  const owner = sessionsDb.getSessionOwnerId(sessionId);
  if (owner === undefined) {
    return true;
  }

  return owner === ownerScope;
}

/** Throws 403 when the user may not touch the session. */
export function assertSessionAccess(user: SessionAccessUser, sessionId: string): void {
  if (!canAccessSession(user, sessionId)) {
    throw new AppError('Session access denied', {
      code: 'SESSION_ACCESS_DENIED',
      statusCode: 403,
    });
  }
}

/**
 * Throws 403 when a restricted user tries to start a chat outside the projects
 * they were granted.
 *
 * The working directory a chat runs in is taken from its session row for every
 * later turn, so the path supplied when the session is created is the last
 * point at which project grants can still be enforced.
 */
export function assertProjectPathAccess(user: SessionAccessUser, projectPath: string): void {
  const ownerScope = resolveSessionOwnerScope(user);
  if (ownerScope === null) {
    return;
  }

  const project = projectsDb.getProjectPath(projectPath);
  if (!project || !userProjectAccessDb.canAccess(ownerScope, project.project_id)) {
    throw new AppError('Project access denied', {
      code: 'PROJECT_ACCESS_DENIED',
      statusCode: 403,
    });
  }
}

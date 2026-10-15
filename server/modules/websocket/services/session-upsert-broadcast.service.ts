import path from 'node:path';

import { canReadSession, isSessionReadOnlyFor, resolveSessionOwnerScope } from '@/modules/auth/index.js';
import { projectsDb, sessionSharesDb, sessionsDb, userProjectAccessDb } from '@/modules/database/index.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import { connectedClients, connectionUsers, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { AuthenticatedWebSocketUser, SessionUpsertedEvent } from '@/shared/types.js';

/** One built event plus what the per-viewer variants are derived from. */
type BuiltSessionUpsert = {
  event: SessionUpsertedEvent;
  ownerUserId: number | null;
};

/**
 * The single producer of the `session_upserted` delta.
 *
 * The event carries everything a sidebar needs to upsert a session in place
 * (its summary plus the owning project's metadata), so clients never refetch
 * the whole project list because one transcript changed on disk.
 *
 * It used to be built in two places — the on-disk sessions watcher and the
 * chat run registry — and only the registry's copy set `providerSessionId`.
 * That field is how the client notices a row it is showing has been merged
 * into its canonical app-session row, so a merge announced by any other path
 * left a stale duplicate in the sidebar. One builder, one shape.
 */
async function buildSessionUpsert(
  sessionIdOrProviderSessionId: string,
): Promise<BuiltSessionUpsert | null> {
  // Resolving by provider id first covers the watcher, which only ever sees
  // the id written in the transcript. For a row where the two ids are equal
  // — legacy rows, and any session indexed from disk before its mapping
  // existed — both lookups land on the same row anyway.
  const row = sessionsDb.getSessionByProviderSessionId(sessionIdOrProviderSessionId)
    ?? sessionsDb.getSessionById(sessionIdOrProviderSessionId);
  if (!row || row.isArchived) {
    return null;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  const sharedWith = sessionSharesDb.countSharesBySession([row.session_id]).get(row.session_id);
  const event: SessionUpsertedEvent = {
    kind: 'session_upserted',
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id ?? null,
    // The column is a plain TEXT and typed as `string` on the row, but only
    // provider adapters ever write it.
    provider: row.provider as SessionUpsertedEvent['provider'],
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
      // Always a number for admins: the client merges upserts into the row it
      // has, so an absent field would leave a stale count after unsharing.
      sharedWith: sharedWith ?? 0,
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
      }
      : null,
    timestamp: new Date().toISOString(),
  };
  return { event, ownerUserId: row.owner_user_id ?? null };
}

/** The admin view of an event: the session as is, with its share count. */
async function buildSessionUpsertedEvent(
  sessionIdOrProviderSessionId: string,
): Promise<SessionUpsertedEvent | null> {
  return (await buildSessionUpsert(sessionIdOrProviderSessionId))?.event ?? null;
}

/**
 * The payload one connection receives, or `null` when it must not hear about
 * the session. Admins get the event as built; a restricted user only gets
 * chats they may read, marked `readOnly` when not theirs, with the project
 * marked `sharedOnly` when they reach it through a share alone. The share
 * count is admin information and is dropped for them.
 */
function payloadForViewer(built: BuiltSessionUpsert, user: AuthenticatedWebSocketUser | undefined, adminPayload: string): string | null {
  let viewerId: number | null;
  try {
    viewerId = resolveSessionOwnerScope(user);
  } catch {
    return null;
  }
  if (viewerId === null) {
    return adminPayload;
  }
  if (!canReadSession(user, built.event.sessionId)) {
    return null;
  }

  const { sharedWith: _sharedWith, ...session } = built.event.session;
  const project = built.event.project;
  const sharedOnly = Boolean(project) && !userProjectAccessDb.canAccess(viewerId, project!.projectId);
  return JSON.stringify({
    ...built.event,
    session: isSessionReadOnlyFor(user, built.ownerUserId) ? { ...session, readOnly: true } : session,
    project: project && sharedOnly ? { ...project, sharedOnly: true } : project,
  });
}

function sendToConnectedClients(builtEvents: BuiltSessionUpsert[]): void {
  if (builtEvents.length === 0) {
    return;
  }

  const adminPayloads = builtEvents.map((built) => JSON.stringify(built.event));
  connectedClients.forEach((client) => {
    if (client.readyState !== WS_OPEN_STATE) {
      return;
    }
    const user = connectionUsers.get(client);
    builtEvents.forEach((built, index) => {
      const payload = payloadForViewer(built, user, adminPayloads[index]);
      if (payload) {
        client.send(payload);
      }
    });
  });
}

/** Announces one session. Used by the chat run registry when a run reports its provider-native id. */
export async function broadcastSessionUpserted(sessionIdOrProviderSessionId: string): Promise<void> {
  const built = await buildSessionUpsert(sessionIdOrProviderSessionId);
  if (built) {
    sendToConnectedClients([built]);
  }
}

/**
 * Announces a batch of sessions. Used by the providers module's sessions
 * watcher, whose debounced flush can carry dozens of ids at once — the client
 * set is walked once for the whole batch rather than once per session.
 */
export async function broadcastSessionUpsertedBatch(
  sessionIds: Iterable<string>,
): Promise<void> {
  const builtEvents: BuiltSessionUpsert[] = [];
  for (const sessionId of sessionIds) {
    const built = await buildSessionUpsert(sessionId);
    if (built) {
      builtEvents.push(built);
    }
  }

  sendToConnectedClients(builtEvents);
}

/** @internal Exported for the broadcast tests, which assert the payload shape directly. */
export { buildSessionUpsertedEvent };

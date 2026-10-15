import type { AuthenticatedWebSocketUser, RealtimeClientConnection } from '@/shared/types.js';

/**
 * Numeric readyState for an open WebSocket connection.
 *
 * We keep this in module state so services that broadcast updates do not need
 * to import `ws` directly just to compare open/closed state.
 */
export const WS_OPEN_STATE = 1;

/**
 * Shared registry of active chat WebSocket connections.
 *
 * Project/session services publish realtime updates by iterating this set.
 */
export const connectedClients = new Set<RealtimeClientConnection>();

/**
 * The authenticated user behind each chat connection. Broadcasts that carry
 * one session (`session_upserted`) consult it so a restricted user only hears
 * about chats they may read. A connection without an entry is treated like an
 * admin, as everywhere else a missing role is.
 */
export const connectionUsers = new WeakMap<RealtimeClientConnection, AuthenticatedWebSocketUser | undefined>();

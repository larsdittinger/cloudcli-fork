import { canReadSession } from '@/modules/auth/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients, connectionUsers, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * Applies a change of who may read which chats (a share, the "sees all chats"
 * flag, project grants) to live connections. Restricted sockets that can no
 * longer read a running chat stop receiving it, and every restricted client is
 * told to reload its project list, which drops revoked chats and picks up new
 * ones. Used by the admin module after each such change.
 */
export function applyChatAccessChange(): void {
  chatRunRegistry.pruneConnections((connection, appSessionId) => {
    const user = connectionUsers.get(connection);
    try {
      return canReadSession(user, appSessionId);
    } catch {
      return false;
    }
  });

  const payload = JSON.stringify({ kind: 'chat_access_changed', timestamp: new Date().toISOString() });
  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE && connectionUsers.get(client)?.role === 'restricted') {
      client.send(payload);
    }
  });
}

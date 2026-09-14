import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/index.js';
import type { MessageStatus, OutboxStatus } from '@/modules/channels/types.js';

function sendToAll(payload: Record<string, unknown>): void {
  const serialized = JSON.stringify({ ...payload, timestamp: new Date().toISOString() });
  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(serialized);
    }
  });
}

/** Tells every open tab an inbound message changed, so the inbox badge and lists refetch. */
export function broadcastInboxUpdated(payload: { messageId: string; status: MessageStatus; sessionId?: string | null }): void {
  sendToAll({ kind: 'channels_inbox_updated', ...payload });
}

/** Tells every open tab an outgoing message moved, so the chat's draft card and the outbox refetch. */
export function broadcastOutboxUpdated(payload: { outboxId: string; sessionId: string | null; status: OutboxStatus }): void {
  sendToAll({ kind: 'channels_outbox_updated', ...payload });
}

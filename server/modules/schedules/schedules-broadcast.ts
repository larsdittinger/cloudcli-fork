import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/index.js';

/** Tells every open tab a schedule or run changed, so the Schedules tab refetches. */
export function broadcastSchedulesUpdated(payload: { scheduleId?: string; runId?: string } = {}): void {
  const serialized = JSON.stringify({ kind: 'schedules_updated', ...payload, timestamp: new Date().toISOString() });
  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) client.send(serialized);
  });
}

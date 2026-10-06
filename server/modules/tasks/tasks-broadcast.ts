import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/index.js';

/** Tells every open tab a task changed, so the Tasks tab and its badge refetch. */
export function broadcastTasksUpdated(payload: { taskId?: number } = {}): void {
  const serialized = JSON.stringify({ kind: 'tasks_updated', ...payload, timestamp: new Date().toISOString() });
  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) client.send(serialized);
  });
}

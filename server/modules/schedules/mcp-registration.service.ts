import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { appConfigDb } from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/index.js';

const MCP_TOKEN_KEY = 'schedules_mcp_token';
export const SCHEDULES_MCP_SERVER_NAME = 'cloudcli-schedules';

/** Used by the MCP routes (to check) and the registration (to hand out) the local bridge token. */
export function getSchedulesMcpToken(): string {
  let token = appConfigDb.get(MCP_TOKEN_KEY);
  if (!token) {
    token = randomBytes(24).toString('hex');
    appConfigDb.set(MCP_TOKEN_KEY, token);
  }
  return token;
}

/**
 * Used by the schedules module at start: (re)writes the `cloudcli-schedules`
 * entry in every provider's user MCP config, so each agent can propose
 * schedules. Idempotent; a failure only means agents lack the tools.
 */
export async function registerSchedulesMcp(): Promise<void> {
  const scriptPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'schedules-mcp.js');
  const port = process.env.SERVER_PORT || process.env.PORT || '3001';
  try {
    await providerMcpService.addMcpServerToAllProviders({
      name: SCHEDULES_MCP_SERVER_NAME,
      scope: 'user',
      transport: 'stdio',
      command: process.execPath,
      args: [scriptPath],
      env: {
        CLOUDCLI_SCHEDULES_MCP_TOKEN: getSchedulesMcpToken(),
        CLOUDCLI_SCHEDULES_API_URL: `http://127.0.0.1:${port}/api/schedules-mcp`,
      },
    });
  } catch (error) {
    console.warn('[Schedules] MCP registration failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

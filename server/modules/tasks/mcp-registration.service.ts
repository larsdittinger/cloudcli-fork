import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { appConfigDb } from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/index.js';

const MCP_TOKEN_KEY = 'tasks_mcp_token';
export const TASKS_MCP_SERVER_NAME = 'cloudcli-tasks';

/** Used by the MCP routes (to check) and the registration (to hand out) the local bridge token. */
export function getTasksMcpToken(): string {
  let token = appConfigDb.get(MCP_TOKEN_KEY);
  if (!token) {
    token = randomBytes(24).toString('hex');
    appConfigDb.set(MCP_TOKEN_KEY, token);
  }
  return token;
}

/**
 * Used by the tasks module at start: (re)writes the `cloudcli-tasks` entry in
 * every provider's user MCP config, so each agent can run long-running tasks.
 * Idempotent; a failure only means agents lack the tools.
 */
export async function registerTasksMcp(): Promise<void> {
  const scriptPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'tasks-mcp.js');
  const port = process.env.SERVER_PORT || process.env.PORT || '3001';
  try {
    await providerMcpService.addMcpServerToAllProviders({
      name: TASKS_MCP_SERVER_NAME,
      scope: 'user',
      transport: 'stdio',
      command: process.execPath,
      args: [scriptPath],
      env: {
        CLOUDCLI_TASKS_MCP_TOKEN: getTasksMcpToken(),
        CLOUDCLI_TASKS_API_URL: `http://127.0.0.1:${port}/api/tasks-mcp`,
      },
    });
  } catch (error) {
    console.warn('[Tasks] MCP registration failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

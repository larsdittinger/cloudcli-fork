import { randomUUID } from 'node:crypto';

import { schedulesDb, sessionsDb } from '@/modules/database/index.js';
import type { ScheduleRow } from '@/modules/database/index.js';
import { broadcastSessionUpserted, chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

function runOptions(schedule: ScheduleRow): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (schedule.model) options.model = schedule.model;
  if (schedule.effort) options.effort = schedule.effort;
  if (schedule.permission_mode && schedule.permission_mode !== 'default') options.permissionMode = schedule.permission_mode;
  return options;
}

/**
 * Used by the schedule executor: one AI turn as a normal sidebar chat. A new
 * chat per run, or one chat the schedule keeps continuing (`session_mode`).
 * Resolves when the turn ends; there is deliberately no time limit.
 * `busy` means the continued chat was still running and nothing started.
 */
export async function runPromptTurn(input: {
  schedule: ScheduleRow;
  content: string;
  title: string;
  runtime: ProviderRuntimeGateway;
  onSession?: (sessionId: string) => void;
}): Promise<{ sessionId: string | null; error: string | null; busy?: boolean }> {
  const { schedule } = input;
  let sessionId: string;
  const continued = schedule.session_mode === 'continue' && schedule.session_id && sessionsDb.getSessionById(schedule.session_id);
  if (continued) {
    sessionId = schedule.session_id as string;
    if (chatRunRegistry.isProcessing(sessionId)) {
      return { sessionId, error: 'The chat is still busy with an earlier turn.', busy: true };
    }
  } else {
    sessionId = randomUUID();
    sessionsDb.createAppSession(sessionId, schedule.provider, schedule.project_path, input.title, schedule.owner_user_id);
    if (schedule.session_mode === 'continue') schedulesDb.setSessionId(schedule.id, sessionId);
    await broadcastSessionUpserted(sessionId);
  }
  input.onSession?.(sessionId);

  try {
    const result = await runDetachedChatTurn(
      { sessionId, userId: schedule.owner_user_id, content: input.content, options: runOptions(schedule) },
      { runtime: input.runtime },
    );
    if (!result.started) return { sessionId, error: result.error ?? 'The chat turn did not start.' };
    return { sessionId, error: result.error };
  } catch (error) {
    return { sessionId, error: error instanceof Error ? error.message : String(error) };
  }
}

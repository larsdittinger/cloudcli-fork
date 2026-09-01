/**
 * The chat socket is the one place where knowing a session id would otherwise
 * be enough to read or continue somebody else's conversation, so it enforces
 * ownership on its own rather than trusting the routes that listed the ids.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import type { AuthenticatedWebSocketRequest, AuthenticatedWebSocketUser } from '@/shared/types.js';

type SentFrame = { kind?: string; code?: string; sessionId?: string | null };

type FakeSocket = {
  readyState: number;
  sent: SentFrame[];
  send(payload: string): void;
  on(event: string, handler: (raw: unknown) => unknown): void;
  emit(event: string, raw: unknown): Promise<void>;
};

function createFakeSocket(): FakeSocket {
  const handlers = new Map<string, (raw: unknown) => unknown>();

  return {
    readyState: 1,
    sent: [],
    send(payload: string) {
      this.sent.push(JSON.parse(payload) as SentFrame);
    },
    on(event: string, handler: (raw: unknown) => unknown) {
      handlers.set(event, handler);
    },
    async emit(event: string, raw: unknown) {
      await handlers.get(event)?.(raw);
    },
  };
}

const runtime = {
  hasRuntime: () => true,
  run: async () => undefined,
  abort: async () => true,
  resolveToolApproval: () => undefined,
  getPendingApprovalsForSession: () => [],
};

async function withChatSocket(
  user: AuthenticatedWebSocketUser,
  run: (socket: FakeSocket) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-ws-access-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const socket = createFakeSocket();
  handleChatConnection(
    socket as unknown as Parameters<typeof handleChatConnection>[0],
    { user } as AuthenticatedWebSocketRequest,
    { runtime } as unknown as Parameters<typeof handleChatConnection>[2],
  );

  try {
    await run(socket);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const restricted: AuthenticatedWebSocketUser = { id: 7, role: 'restricted' };

test('chat.send into someone else\'s session is refused', async () => {
  await withChatSocket(restricted, async (socket) => {
    sessionsDb.createAppSession('theirs-1', 'claude', '/workspace/demo', 'Theirs', 9);

    await socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: 'theirs-1',
      content: 'let me in',
    }));

    assert.deepEqual(
      socket.sent.map((frame) => [frame.kind, frame.code]),
      [['protocol_error', 'SESSION_ACCESS_DENIED']],
    );
  });
});

test('chat.send into an unowned session is refused', async () => {
  await withChatSocket(restricted, async (socket) => {
    sessionsDb.createSession('orphan-1', 'claude', '/workspace/demo');

    await socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: 'orphan-1',
      content: 'let me in',
    }));

    assert.deepEqual(
      socket.sent.map((frame) => [frame.kind, frame.code]),
      [['protocol_error', 'SESSION_ACCESS_DENIED']],
    );
  });
});

test('chat.abort on someone else\'s session is refused', async () => {
  await withChatSocket(restricted, async (socket) => {
    sessionsDb.createAppSession('theirs-1', 'claude', '/workspace/demo', 'Theirs', 9);

    await socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: 'theirs-1' }));

    assert.deepEqual(
      socket.sent.map((frame) => [frame.kind, frame.code]),
      [['protocol_error', 'SESSION_ACCESS_DENIED']],
    );
  });
});

test('chat.subscribe silently skips sessions the user does not own', async () => {
  await withChatSocket(restricted, async (socket) => {
    sessionsDb.createAppSession('mine-1', 'claude', '/workspace/demo', 'Mine', 7);
    sessionsDb.createAppSession('theirs-1', 'claude', '/workspace/demo', 'Theirs', 9);

    await socket.emit('message', JSON.stringify({
      type: 'chat.subscribe',
      sessions: [{ sessionId: 'theirs-1' }, { sessionId: 'mine-1' }],
    }));

    assert.deepEqual(
      socket.sent.map((frame) => [frame.kind, frame.sessionId]),
      [['chat_subscribed', 'mine-1']],
    );
  });
});

test('an admin socket reaches every session', async () => {
  await withChatSocket({ id: 1, role: 'admin' }, async (socket) => {
    sessionsDb.createAppSession('theirs-1', 'claude', '/workspace/demo', 'Theirs', 9);

    await socket.emit('message', JSON.stringify({
      type: 'chat.subscribe',
      sessions: [{ sessionId: 'theirs-1' }],
    }));

    assert.deepEqual(
      socket.sent.map((frame) => [frame.kind, frame.sessionId]),
      [['chat_subscribed', 'theirs-1']],
    );
  });
});

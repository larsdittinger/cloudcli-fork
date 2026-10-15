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

import { closeConnection, initializeDatabase, sessionSharesDb, sessionsDb, userDb } from '@/modules/database/index.js';
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
  hasBackgroundWork: () => false,
  ownsLiveProcess: () => false,
};

async function withChatSocket(
  user: AuthenticatedWebSocketUser,
  run: (socket: FakeSocket) => Promise<void>,
  runtimeOverrides: Record<string, unknown> = {},
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
    { runtime: { ...runtime, ...runtimeOverrides } } as unknown as Parameters<typeof handleChatConnection>[2],
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

test('chat.abort stops a turn the held process started on its own', async () => {
  const aborted: string[] = [];
  await withChatSocket(restricted, async (socket) => {
    sessionsDb.createAppSession('held-1', 'claude', '/workspace/demo', 'Held', 7);

    await socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: 'held-1' }));

    assert.deepEqual(aborted, ['held-1']);
    assert.deepEqual(
      socket.sent.map((frame) => [frame.kind, frame.sessionId, (frame as { aborted?: boolean }).aborted]),
      [['complete', 'held-1', true]],
    );
  }, {
    ownsLiveProcess: (_provider: string, sessionId: string) => sessionId === 'held-1',
    abort: async (_provider: string, sessionId: string) => { aborted.push(sessionId); return true; },
  });
});

test('chat.abort without a run or a live process reports no active run', async () => {
  await withChatSocket(restricted, async (socket) => {
    sessionsDb.createAppSession('idle-1', 'claude', '/workspace/demo', 'Idle', 7);

    await socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: 'idle-1' }));

    assert.deepEqual(
      socket.sent.map((frame) => [frame.kind, frame.code]),
      [['protocol_error', 'NO_ACTIVE_RUN']],
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

// ---------------------------------------------------------------------------
// A chat an admin shared with a restricted user: watched live, never written.
// ---------------------------------------------------------------------------

// In a fresh database the admin gets id 1 and the first restricted user id 2.
const viewer: AuthenticatedWebSocketUser = { id: 2, role: 'restricted' };

function seedSharedChat(): void {
  userDb.createUser('admin', 'hash');
  const viewerId = Number(userDb.createUserWithRole('viewer', 'hash', 'restricted').id);
  assert.equal(viewerId, 2);
  sessionsDb.createAppSession('ceo-1', 'claude', '/workspace/ceo', 'CEO chat', null);
  sessionSharesDb.setUsersForSession('ceo-1', [viewerId]);
}

const pendingCeoApproval = {
  getPendingApprovalsForSession: (sessionId: string) => (
    sessionId === 'ceo-1' ? [{ requestId: 'req-1', toolName: 'Bash', sessionId }] : []
  ),
};

test('a shared chat can be subscribed to, without its pending approvals', async () => {
  await withChatSocket(viewer, async (socket) => {
    seedSharedChat();

    await socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: 'ceo-1' }] }));

    assert.deepEqual(
      socket.sent.map((frame) => [
        frame.kind,
        frame.sessionId,
        (frame as { pendingPermissions?: unknown[] }).pendingPermissions,
        (frame as { readOnly?: boolean }).readOnly,
      ]),
      [['chat_subscribed', 'ceo-1', [], true]],
    );
  }, pendingCeoApproval);
});

test('a shared chat refuses send, abort and stopping an agent', async () => {
  await withChatSocket(viewer, async (socket) => {
    seedSharedChat();

    await socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: 'ceo-1', content: 'hi' }));
    await socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: 'ceo-1' }));
    await socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: 'ceo-1', taskId: 'agent-1' }));

    assert.deepEqual(
      socket.sent.map((frame) => [frame.kind, frame.code]),
      [
        ['protocol_error', 'SESSION_ACCESS_DENIED'],
        ['protocol_error', 'SESSION_ACCESS_DENIED'],
        ['protocol_error', 'SESSION_ACCESS_DENIED'],
      ],
    );
  }, { stopBackgroundTask: async () => assert.fail('a viewer must not stop an agent') });
});

test('a viewer cannot answer a permission request of a shared chat', async () => {
  const resolved: string[] = [];
  await withChatSocket(viewer, async (socket) => {
    seedSharedChat();

    // With and without naming the chat: both are refused.
    await socket.emit('message', JSON.stringify({ type: 'chat.permission-response', requestId: 'req-1', allow: true }));
    await socket.emit('message', JSON.stringify({
      type: 'chat.permission-response', sessionId: 'ceo-1', requestId: 'req-1', allow: true,
    }));

    assert.deepEqual(resolved, []);
  }, { ...pendingCeoApproval, resolveToolApproval: (requestId: string) => { resolved.push(requestId); } });
});

test('a restricted owner answers a permission request of their own chat', async () => {
  const resolved: string[] = [];
  await withChatSocket(restricted, async (socket) => {
    sessionsDb.createAppSession('mine-1', 'claude', '/workspace/demo', 'Mine', 7);

    await socket.emit('message', JSON.stringify({
      type: 'chat.permission-response', sessionId: 'mine-1', requestId: 'req-9', allow: true,
    }));
    // An id pending in another chat is not theirs to answer.
    await socket.emit('message', JSON.stringify({
      type: 'chat.permission-response', sessionId: 'mine-1', requestId: 'req-other', allow: true,
    }));

    assert.deepEqual(resolved, ['req-9']);
  }, {
    getPendingApprovalsForSession: (sessionId: string) => (sessionId === 'mine-1' ? [{ requestId: 'req-9' }] : []),
    resolveToolApproval: (requestId: string) => { resolved.push(requestId); },
  });
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionSharesDb,
  sessionsDb,
  userDb,
  userProjectAccessDb,
} from '@/modules/database/index.js';
import {
  broadcastSessionUpserted,
  broadcastSessionUpsertedBatch,
} from '@/modules/websocket/services/session-upsert-broadcast.service.js';
import { connectedClients, connectionUsers } from '@/modules/websocket/services/websocket-state.service.js';

class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-upsert-broadcast-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('an upsert always carries the provider session id', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-1', 'opencode', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-1', 'native-1');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpserted('app-1');

    assert.equal(connection.frames.length, 1);
    assert.equal(connection.frames[0].kind, 'session_upserted');
    assert.equal(connection.frames[0].sessionId, 'app-1');
    assert.equal(connection.frames[0].providerSessionId, 'native-1');
  });
});

test('the watcher path resolves a provider-native id to the same canonical event', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-2', 'opencode', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-2', 'native-2');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    // The sessions watcher only ever knows the id written in the transcript.
    await broadcastSessionUpsertedBatch(['native-2']);

    assert.equal(connection.frames.length, 1);
    assert.equal(connection.frames[0].sessionId, 'app-2');
    assert.equal(connection.frames[0].providerSessionId, 'native-2');
  });
});

test('a session with no provider id yet reports null rather than omitting the field', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-3', 'claude', '/workspace/demo');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpserted('app-3');

    assert.equal(connection.frames.length, 1);
    assert.ok('providerSessionId' in connection.frames[0]);
    assert.equal(connection.frames[0].providerSessionId, null);
  });
});

test('an unresolvable id broadcasts nothing', async () => {
  await withIsolatedDatabase(async () => {
    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpserted('does-not-exist');
    await broadcastSessionUpsertedBatch(['also-missing']);

    assert.deepEqual(connection.frames, []);
  });
});

test('a batch delivers every resolvable session and skips the rest', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-4', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('app-5', 'claude', '/workspace/demo');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpsertedBatch(['app-4', 'missing', 'app-5']);

    assert.deepEqual(
      connection.frames.map((frame) => frame.sessionId),
      ['app-4', 'app-5'],
    );
  });
});

test('a closed socket is skipped', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-6', 'claude', '/workspace/demo');

    const open = new FakeConnection();
    const closing = new FakeConnection();
    closing.readyState = 3;
    connectedClients.add(open as never);
    connectedClients.add(closing as never);

    await broadcastSessionUpserted('app-6');

    assert.equal(open.frames.length, 1);
    assert.deepEqual(closing.frames, []);
  });
});

test('restricted sockets only hear about chats they may read, flagged read-only', async () => {
  await withIsolatedDatabase(async () => {
    userDb.createUser('admin', 'hash');
    const viewerId = Number(userDb.createUserWithRole('viewer', 'hash', 'restricted').id);
    const marketing = projectsDb.createProjectPath('/workspace/marketing');
    userProjectAccessDb.setProjectsForUser(viewerId, [marketing.project!.project_id]);
    sessionsDb.createAppSession('own', 'claude', '/workspace/marketing', 'Own', viewerId);
    sessionsDb.createAppSession('ceo-shared', 'claude', '/workspace/ceo', 'Shared', null);
    sessionsDb.createAppSession('ceo-private', 'claude', '/workspace/ceo', 'Private', null);
    sessionSharesDb.setUsersForSession('ceo-shared', [viewerId]);

    const admin = new FakeConnection();
    const viewer = new FakeConnection();
    connectedClients.add(admin as never);
    connectedClients.add(viewer as never);
    connectionUsers.set(admin as never, { id: 1, role: 'admin' });
    connectionUsers.set(viewer as never, { userId: viewerId, role: 'restricted' });

    await broadcastSessionUpsertedBatch(['own', 'ceo-shared', 'ceo-private']);

    assert.deepEqual(admin.frames.map((frame) => frame.sessionId), ['own', 'ceo-shared', 'ceo-private']);
    assert.equal((admin.frames[1].session as { sharedWith?: number }).sharedWith, 1);
    assert.deepEqual(viewer.frames.map((frame) => frame.sessionId), ['own', 'ceo-shared']);
    assert.equal((viewer.frames[0].session as { readOnly?: boolean }).readOnly, undefined);
    assert.equal((viewer.frames[1].session as { readOnly?: boolean }).readOnly, true);
    assert.equal((viewer.frames[0].project as { sharedOnly?: boolean }).sharedOnly, undefined);
    assert.equal((viewer.frames[1].project as { sharedOnly?: boolean }).sharedOnly, true);
  });
});

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import channelsRoutes from '@/modules/channels/channels.routes.js';
import { makeMessage, withIsolatedDatabase } from '@/modules/channels/tests/helpers.js';
import { channelMessagesDb } from '@/modules/database/index.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';

type Json = Record<string, any>;

/** A socket that records the frames the server broadcasts. */
function recordingClient() {
  const frames: Json[] = [];
  return { frames, client: { readyState: WS_OPEN_STATE, send: (data: string) => frames.push(JSON.parse(data) as Json) } };
}

async function withServer(runTest: (call: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: Json }>) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use('/api/channels', channelsRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ success: false, error: { message: String(err) } });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Json };
  };
  try {
    await runTest(call);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('ignoring a message tells every tab, so the sidebar badge drops it', async () => {
  // Regression: the route used to change the status silently; the badge
  // refetches only on a `channels_inbox_updated` frame and kept counting spam.
  await withIsolatedDatabase(async () => {
    const spam = channelMessagesDb.insert(makeMessage({ subject: 'You won!' }), 'unmatched')!;
    const { frames, client } = recordingClient();
    connectedClients.add(client as never);
    try {
      await withServer(async (call) => {
        assert.equal((await call('GET', '/api/channels/summary')).json.data.unmatched, 1);
        assert.equal((await call('POST', `/api/channels/messages/${spam.id}/ignore`)).status, 200);
        assert.ok(frames.some((frame) => frame.kind === 'channels_inbox_updated'));
        assert.equal((await call('GET', '/api/channels/summary')).json.data.unmatched, 0);
      });
    } finally {
      connectedClients.delete(client as never);
    }
  });
});

test('read messages leave the badge; a later failure brings one back', async () => {
  await withIsolatedDatabase(async () => {
    const first = channelMessagesDb.insert(makeMessage(), 'unmatched')!;
    const second = channelMessagesDb.insert(makeMessage(), 'unmatched')!;
    const held = channelMessagesDb.insert(makeMessage(), 'held')!;

    await withServer(async (call) => {
      assert.equal((await call('POST', '/api/channels/messages/mark-read', { ids: [] })).status, 400);
      assert.equal((await call('POST', '/api/channels/messages/mark-read', { ids: [42] })).status, 400);

      const one = await call('POST', '/api/channels/messages/mark-read', { ids: [first.id, first.id] });
      assert.equal(one.json.data.updated, 1);
      let summary = (await call('GET', '/api/channels/summary')).json.data;
      assert.equal(summary.unmatched, 1);
      assert.equal(summary.held, 1);

      const listed = (await call('GET', '/api/channels/messages')).json.data as Json[];
      assert.equal(listed.find((message) => message.id === first.id)?.read, true);
      assert.equal(listed.find((message) => message.id === second.id)?.read, false);

      const all = await call('POST', '/api/channels/messages/mark-read', { all: true });
      assert.equal(all.json.data.updated, 2);
      summary = (await call('GET', '/api/channels/summary')).json.data;
      assert.equal(summary.unmatched + summary.held + summary.failed, 0);
      // Read is attention only: the held message still waits for a decision.
      assert.equal(channelMessagesDb.get(held.id)?.status, 'held');

      channelMessagesDb.setStatus(second.id, 'failed', 'agent crashed');
      assert.equal((await call('GET', '/api/channels/summary')).json.data.failed, 1);
    });
  });
});

test('bulk ignore spares messages already with an agent, bulk delete removes rows', async () => {
  await withIsolatedDatabase(async () => {
    const spam = channelMessagesDb.insert(makeMessage(), 'unmatched')!;
    const working = channelMessagesDb.insert(makeMessage(), 'dispatched')!;
    const old = channelMessagesDb.insert(makeMessage(), 'ignored')!;

    await withServer(async (call) => {
      const ignored = await call('POST', '/api/channels/messages/ignore', { ids: [spam.id, working.id] });
      assert.equal(ignored.json.data.ignored, 1);
      assert.equal(channelMessagesDb.get(spam.id)?.status, 'ignored');
      assert.equal(channelMessagesDb.get(working.id)?.status, 'dispatched');

      const deleted = await call('POST', '/api/channels/messages/delete', { ids: [old.id, spam.id, 'missing'] });
      assert.equal(deleted.json.data.deleted, 2);
      assert.equal(channelMessagesDb.get(old.id), null);
      assert.equal(channelMessagesDb.get(spam.id), null);
      assert.ok(channelMessagesDb.get(working.id));
    });
  });
});

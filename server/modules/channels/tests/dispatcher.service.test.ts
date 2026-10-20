import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { mock } from 'node:test';

import { dispatchMessage, dispatchQueuedMessages } from '@/modules/channels/dispatcher.service.js';
import { createRuntime, makeMessage, withIsolatedDatabase } from '@/modules/channels/tests/helpers.js';
import type { RunCall } from '@/modules/channels/tests/helpers.js';
import type { RuleInput } from '@/modules/channels/types.js';
import { channelAccountsDb, channelMessagesDb, channelRulesDb, channelThreadsDb, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { daemonClient, isolationDb } from '@/modules/isolation/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';

/** Isolation env pointing at directories under `dir`, for the duration of `run`. */
async function withIsolationEnvUnder(dir: string, run: () => Promise<void>) {
  const env: Record<string, string> = {
    CLOUDCLI_ISOLATED_ROOT: path.join(dir, 'isolated'),
    CLOUDCLI_ISOLATED_HOMES: path.join(dir, 'homes'),
    CLOUDCLI_ISOLATION_DIR: path.join(dir, 'iso'),
    CLOUDCLI_SANDBOX_DAEMON_TOKEN: 'daemon-token',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
    if (key !== 'CLOUDCLI_SANDBOX_DAEMON_TOKEN') fs.mkdirSync(value, { recursive: true });
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function seed(ruleOverrides: Partial<RuleInput> = {}, projectPath = '/tmp/channels-project') {
  const account = channelAccountsDb.create({ type: 'email', label: 'Gmail', config: {}, secrets: {} });
  const rule = channelRulesDb.create({
    name: 'orders',
    conditions: { senders: ['@firma.cz'] },
    projectPath,
    provider: 'claude',
    permissionMode: 'bypassPermissions',
    replyMode: 'draft',
    ...ruleOverrides,
  });
  return { account, rule };
}

test('a message creates a chat in the rule project and runs the rendered prompt', async () => {
  await withIsolatedDatabase(async (dir) => {
    const { account, rule } = seed({}, dir);
    const row = channelMessagesDb.insert(makeMessage({ accountId: account.id, text: 'chci 3 kusy' }), 'unmatched')!;

    const runs: RunCall[] = [];
    const result = await dispatchMessage(row.id, rule.id, createRuntime(runs));

    assert.equal(result.started, true);
    assert.ok(result.sessionId);
    const session = sessionsDb.getSessionById(result.sessionId!);
    assert.equal(session?.project_path, dir);
    assert.ok(session?.custom_name?.startsWith('E-mail: Jan Novak'));
    assert.equal(runs.length, 1);
    assert.ok(runs[0].command.includes('chci 3 kusy'));
    assert.ok(runs[0].command.includes(row.id));
    assert.equal(runs[0].options.permissionMode, 'bypassPermissions');
    assert.equal(channelMessagesDb.get(row.id)?.status, 'dispatched');
    assert.equal(channelMessagesDb.get(row.id)?.session_id, result.sessionId);
  });
});

test('a second message in the same thread continues the same chat; conversation=new never does', async () => {
  await withIsolatedDatabase(async (dir) => {
    const { account, rule } = seed({}, dir);
    const first = channelMessagesDb.insert(makeMessage({ accountId: account.id, threadKey: 't-1' }), 'unmatched')!;
    const second = channelMessagesDb.insert(makeMessage({ accountId: account.id, threadKey: 't-1' }), 'unmatched')!;

    const runs: RunCall[] = [];
    const a = await dispatchMessage(first.id, rule.id, createRuntime(runs));
    const b = await dispatchMessage(second.id, rule.id, createRuntime(runs));
    assert.equal(a.sessionId, b.sessionId);

    const fresh = channelRulesDb.create({ name: 'fresh', conditions: {}, projectPath: dir, provider: 'claude', conversation: 'new' });
    const third = channelMessagesDb.insert(makeMessage({ accountId: account.id, threadKey: 't-1' }), 'unmatched')!;
    const fourth = channelMessagesDb.insert(makeMessage({ accountId: account.id, threadKey: 't-1' }), 'unmatched')!;
    const c = await dispatchMessage(third.id, fresh.id, createRuntime(runs));
    const d = await dispatchMessage(fourth.id, fresh.id, createRuntime(runs));
    assert.notEqual(c.sessionId, d.sessionId);
  });
});

test('a busy chat queues the message and the queue pass sends it once the run ends', async () => {
  await withIsolatedDatabase(async (dir) => {
    const { account, rule } = seed({}, dir);
    const first = channelMessagesDb.insert(makeMessage({ accountId: account.id, threadKey: 't-2' }), 'unmatched')!;
    const runs: RunCall[] = [];
    const a = await dispatchMessage(first.id, rule.id, createRuntime(runs));

    // Simulate a run in progress on that chat.
    chatRunRegistry.startRun({ appSessionId: a.sessionId!, provider: 'claude', providerSessionId: null, connection: null, userId: null });

    const second = channelMessagesDb.insert(makeMessage({ accountId: account.id, threadKey: 't-2' }), 'unmatched')!;
    const b = await dispatchMessage(second.id, rule.id, createRuntime(runs));
    assert.equal(b.started, false);
    assert.equal(channelMessagesDb.get(second.id)?.status, 'queued');
    assert.equal(runs.length, 1);

    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 0);

    chatRunRegistry.clearAll();
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.equal(channelMessagesDb.get(second.id)?.status, 'dispatched');
    assert.equal(runs.length, 2);
  });
});

test('a remembered chat that was deleted is replaced, and a crashing runtime marks the message failed', async () => {
  await withIsolatedDatabase(async (dir) => {
    const { account, rule } = seed({}, dir);
    channelThreadsDb.set(rule.id, 't-3', 'gone-session');
    const row = channelMessagesDb.insert(makeMessage({ accountId: account.id, threadKey: 't-3' }), 'unmatched')!;

    const runs: RunCall[] = [];
    const result = await dispatchMessage(row.id, rule.id, createRuntime(runs));
    assert.equal(result.started, true);
    assert.notEqual(result.sessionId, 'gone-session');
    assert.equal(channelThreadsDb.get(rule.id, 't-3'), result.sessionId);

    const failing = channelMessagesDb.insert(makeMessage({ accountId: account.id, threadKey: 't-4' }), 'unmatched')!;
    const failed = await dispatchMessage(failing.id, rule.id, createRuntime(runs, 'throw'));
    assert.equal(failed.started, false);
    assert.equal(channelMessagesDb.get(failing.id)?.status, 'failed');
    assert.ok(channelMessagesDb.get(failing.id)?.status_detail);
  });
});

test('the run carries the message as run context; a client-set context never passes', async () => {
  await withIsolatedDatabase(async (dir) => {
    const { account, rule } = seed({}, dir);
    const row = channelMessagesDb.insert(makeMessage({ accountId: account.id, threadKey: 't-ctx', from: { address: 'jan@firma.cz', name: 'Jan' } }), 'unmatched')!;
    const runs: RunCall[] = [];
    await dispatchMessage(row.id, rule.id, createRuntime(runs));
    assert.deepEqual(runs[0].options.channelContext, { messageId: row.id, threadKey: 't-ctx', sender: 'jan@firma.cz' });

    const forged: RunCall[] = [];
    await runDetachedChatTurn(
      { sessionId: runs[0].options.sessionId as string, userId: null, content: 'x', options: { channelContext: { messageId: 'other', threadKey: 'other', sender: 'eve@evil.com' }, taskId: 99 } },
      { runtime: createRuntime(forged) },
    );
    assert.equal(forged[0].options.channelContext, undefined);
    assert.equal(forged[0].options.taskId, undefined);
  });
});

test('isolated project: attachments are copied into it; other providers are refused', async () => {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnvUnder(dir, async () => {
      const projectPath = path.join(dir, 'isolated', 'podpora');
      fs.mkdirSync(projectPath, { recursive: true });
      const { project } = projectsDb.createProjectPath(projectPath, 'podpora');
      isolationDb.markIsolated(project!.project_id, 20001);
      const stored = path.join(dir, 'attachments', 'faktura.pdf');
      fs.mkdirSync(path.dirname(stored), { recursive: true });
      fs.writeFileSync(stored, 'PDF');
      const adopt = mock.method(daemonClient, 'adopt', async () => ({ ok: true, warnings: [] }));
      try {
        const { account, rule } = seed({}, projectPath);
        const row = channelMessagesDb.insert(makeMessage({
          accountId: account.id,
          attachments: [{ name: 'faktura.pdf', mime: 'application/pdf', size: 3, path: stored }],
        }), 'unmatched')!;
        const runs: RunCall[] = [];
        const result = await dispatchMessage(row.id, rule.id, createRuntime(runs));
        assert.equal(result.started, true);
        const copy = path.join(projectPath, '.cloudcli-attachments', row.id, 'faktura.pdf');
        assert.equal(fs.readFileSync(copy, 'utf8'), 'PDF');
        assert.ok(runs[0].command.includes(copy));
        assert.equal(runs[0].command.includes(stored), false);

        const codexRule = channelRulesDb.create({ name: 'codex', conditions: {}, projectPath, provider: 'codex' });
        const other = channelMessagesDb.insert(makeMessage({ accountId: account.id }), 'unmatched')!;
        const refused = await dispatchMessage(other.id, codexRule.id, createRuntime(runs));
        assert.equal(refused.started, false);
        assert.equal(refused.error, 'Izolovaný projekt podporuje jen Claude.');
        assert.equal(channelMessagesDb.get(other.id)?.status, 'failed');
        assert.equal(runs.length, 1);
      } finally {
        adopt.mock.restore();
      }
    });
  });
});

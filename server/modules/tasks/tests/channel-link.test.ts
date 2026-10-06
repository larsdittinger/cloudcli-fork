import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { tmpdir } from 'node:os';

import { channelsService } from '@/modules/channels/index.js';
import type { InboundMessage } from '@/modules/channels/index.js';
import { channelAccountsDb, channelOutboxDb, taskEventsDb, tasksDb, taskThreadsDb } from '@/modules/database/index.js';
import { initializeChannelLink, sendTaskMessage } from '@/modules/tasks/channel-link.service.js';
import { tasksService } from '@/modules/tasks/tasks.service.js';
import { withIsolatedDatabase } from '@/modules/tasks/tests/helpers.js';

/** An existing directory: agents may only create tasks in real project folders. */
const AGENT_DIR = tmpdir();

const taskInput = { title: 'Find a label printer', brief: 'Three quotes.', mandate: 'Email printers.', projectPath: '/workspace/ceo_tasks' };

function inbound(accountId: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: randomUUID(),
    accountId,
    channel: 'email',
    externalId: `<${randomUUID()}@print.cz>`,
    threadKey: randomUUID(),
    from: { address: 'sales@print.cz', name: 'Print s.r.o.' },
    to: ['nakup@ethia.cz'],
    subject: 'Nabídka',
    text: '1000 ks = 4 200 Kč bez DPH',
    isGroup: false,
    attachments: [],
    receivedAt: new Date().toISOString(),
    raw: {},
    ...overrides,
  };
}

/** A connected e-mail account whose sends are recorded instead of mailed. */
async function withMailAccount(agentSend: 'auto' | 'draft' | 'off', body: (accountId: string, sent: Array<Record<string, unknown>>) => Promise<void>) {
  await withIsolatedDatabase(async () => {
    initializeChannelLink();
    const account = channelAccountsDb.create({ type: 'email', label: 'Nákup', config: { user: 'nakup@ethia.cz' }, secrets: {}, agentSend });
    const sent: Array<Record<string, unknown>> = [];
    const original = channelsService.getAdapter;
    channelsService.getAdapter = (() => ({
      send: async (input: Record<string, unknown>) => {
        sent.push(input);
        return { externalId: `<OUT-${sent.length}@ethia.cz>` };
      },
    })) as never;
    try {
      await body(account.id, sent);
    } finally {
      channelsService.getAdapter = original;
    }
  });
}

test('a task e-mail is tagged, sent, logged and its thread routes replies back to the task', async () => {
  await withMailAccount('auto', async (accountId, sent) => {
    const task = tasksService.create(taskInput, { by: 'owner' });
    tasksDb.takePendingWake(task.id);
    const result = await sendTaskMessage({ taskId: task.id, accountId, to: 'sales@print.cz', subject: 'Poptávka etiket', text: 'Dobrý den, ...' });
    assert.equal(result.status, 'sent');
    assert.equal(sent[0].subject, `Poptávka etiket [T-${task.id}]`);
    assert.equal(taskThreadsDb.find(accountId, 'out-1@ethia.cz'), task.id, 'the cleaned Message-ID is the reply thread');
    assert.ok(taskEventsDb.list(task.id).some((event) => event.kind === 'message_out' && /sales@print\.cz/.test(event.text)));

    // The supplier answers in the thread, without the tag.
    const reply = await channelsService.ingest(accountId, inbound(accountId, { threadKey: 'out-1@ethia.cz', subject: 'Re: Poptávka etiket' }));
    assert.equal(reply?.status, 'task');
    const event = taskEventsDb.list(task.id).at(-1);
    assert.equal(event?.kind, 'message_in');
    assert.equal(event?.author, 'external');
    assert.match(event?.text ?? '', /4 200 Kč/);
    assert.match(event?.text ?? '', /sales@print\.cz/);
    assert.deepEqual(JSON.parse(tasksDb.get(task.id)?.pending_wake ?? '[]'), ['message']);
  });
});

test('a new e-mail with the tag reaches an open task; a closed task or unknown tag goes to the rules', async () => {
  await withMailAccount('auto', async (accountId) => {
    const task = tasksService.create(taskInput, { by: 'owner' });
    // The tag only counts from someone the task wrote to.
    await sendTaskMessage({ taskId: task.id, accountId, to: 'sales@print.cz', subject: 'Poptávka', text: 'Dobrý den' });
    const tagged = await channelsService.ingest(accountId, inbound(accountId, { subject: `Cena etiket [T-${task.id}]` }));
    assert.equal(tagged?.status, 'task');
    assert.equal(taskThreadsDb.find(accountId, tagged?.thread_key ?? ''), task.id, 'its thread now belongs to the task');

    const unknown = await channelsService.ingest(accountId, inbound(accountId, { subject: 'Cena [T-999]' }));
    assert.equal(unknown?.status, 'unmatched');

    tasksService.setStatus(task.id, 'done');
    const late = await channelsService.ingest(accountId, inbound(accountId, { subject: `Ještě jedna [T-${task.id}]` }));
    assert.equal(late?.status, 'unmatched');
  });
});

test('our own copies are ignored, not fed to the task', async () => {
  await withMailAccount('auto', async (accountId) => {
    const task = tasksService.create(taskInput, { by: 'owner' });
    const own = await channelsService.ingest(accountId, inbound(accountId, { from: { address: 'nakup@ethia.cz' }, subject: `Kopie [T-${task.id}]` }));
    assert.equal(own?.status, 'ignored');
  });
});

test('an unconfirmed mandate turns sends into drafts; sending after approval logs and links the thread', async () => {
  await withMailAccount('auto', async (accountId, sent) => {
    const task = tasksService.create({ ...taskInput, projectPath: undefined }, { by: 'agent', cwd: AGENT_DIR });
    const draft = await sendTaskMessage({ taskId: task.id, accountId, to: 'sales@print.cz', subject: 'Poptávka', text: 'Dobrý den' });
    assert.equal(draft.status, 'draft');
    assert.equal(sent.length, 0);
    assert.equal(tasksService.get(task.id).task.draftCount, 1);
    assert.equal(tasksDb.attention().total, 1);

    const { outboxService } = await import('@/modules/channels/index.js');
    await outboxService.approve(draft.outboxId);
    assert.equal(sent.length, 1);
    assert.equal(taskThreadsDb.find(accountId, 'out-1@ethia.cz'), task.id);
    assert.ok(taskEventsDb.list(task.id).some((event) => event.kind === 'message_out' && /approved/i.test(event.text)));
  });
});

test('the account decides: draft mode keeps a draft, off refuses', async () => {
  await withMailAccount('draft', async (accountId) => {
    const task = tasksService.create(taskInput, { by: 'owner' });
    const result = await sendTaskMessage({ taskId: task.id, accountId, to: 'sales@print.cz', subject: 'Poptávka', text: 'Dobrý den' });
    assert.equal(result.status, 'draft');
  });
  await withMailAccount('off', async (accountId) => {
    const task = tasksService.create(taskInput, { by: 'owner' });
    await assert.rejects(sendTaskMessage({ taskId: task.id, accountId, to: 'sales@print.cz', subject: 'Poptávka', text: 'Dobrý den' }), (error: { statusCode?: number }) => error.statusCode === 403);
  });
});

test('replying to a task message stays in its thread with Re: and the tag', async () => {
  await withMailAccount('auto', async (accountId, sent) => {
    const task = tasksService.create(taskInput, { by: 'owner' });
    await sendTaskMessage({ taskId: task.id, accountId, to: 'sales@print.cz', subject: 'Poptávka', text: 'Dobrý den' });
    sent.length = 0;
    const incoming = await channelsService.ingest(accountId, inbound(accountId, { subject: `Nabídka [T-${task.id}]`, threadKey: 'supplier-thread' }));
    assert.ok(incoming);
    const result = await sendTaskMessage({ taskId: task.id, replyToMessageId: incoming.id, text: 'Děkujeme, a doprava?' });
    assert.equal(result.status, 'sent');
    assert.equal(sent[0].to, 'sales@print.cz');
    assert.equal(sent[0].subject, `Re: Nabídka [T-${task.id}]`);
    assert.equal(channelOutboxDb.get(result.outboxId)?.in_reply_to_message_id, incoming.id);
  });
});

test('closed tasks cannot send and a missing account or recipient is a clear error', async () => {
  await withMailAccount('auto', async (accountId) => {
    const task = tasksService.create(taskInput, { by: 'owner' });
    await assert.rejects(sendTaskMessage({ taskId: task.id, to: 'a@b.cz', subject: 'x', text: 'y' }), (error: { statusCode?: number }) => error.statusCode === 400);
    await assert.rejects(sendTaskMessage({ taskId: task.id, accountId, subject: 'x', text: 'y' }), (error: { statusCode?: number }) => error.statusCode === 400);
    tasksService.setStatus(task.id, 'cancelled');
    await assert.rejects(sendTaskMessage({ taskId: task.id, accountId, to: 'a@b.cz', subject: 'x', text: 'y' }), (error: { statusCode?: number }) => error.statusCode === 409);
  });
});

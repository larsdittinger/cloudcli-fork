import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelMessage, ChannelRule, OutboxItem } from '@/modules/channels/types';

const calls: Array<{ name: string; args: unknown[] }> = [];
let messages: ChannelMessage[] = [];
let outbox: OutboxItem[] = [];

function ok(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ success: true, data })));
}

const rule = { id: 'rule-1', name: 'Podpora', projectPath: '/workspace/support', proposal: null } as unknown as ChannelRule;

vi.mock('@/shared/api', () => ({
  api: {
    channels: {
      accounts: () => ok([]),
      messages: () => ok(messages),
      message: (id: string) => ok(messages.find((message) => message.id === id)),
      rules: () => ok([rule]),
      outbox: () => ok(outbox),
      dispatchMessage: (...args: unknown[]) => { calls.push({ name: 'dispatch', args }); return ok({}); },
      ignoreMessage: () => ok({}),
      approveOutbox: (...args: unknown[]) => { calls.push({ name: 'approve', args }); return ok({}); },
      discardOutbox: () => ok({}),
      retryOutbox: () => ok({}),
      attachmentUrl: () => '#',
    },
  },
  readApiJson: async (response: Response) => response.json(),
}));
vi.mock('@/modules/channels/hooks/useChannelsEvents', () => ({ useChannelsEvents: () => {} }));

const { default: InboxOverlay } = await import('@/modules/channels/inbox/InboxOverlay');

function message(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: 'msg-1', accountId: 'acc', accountLabel: 'Podpora', channel: 'email', externalId: 'x', threadKey: 't',
    from: { address: 'jana@seznam.cz', name: 'Jana' }, to: ['dotazy@ethia.cz'], subject: 'Kde je objednávka', text: 'Dobrý den',
    html: null, isGroup: false, attachments: [], receivedAt: new Date().toISOString(), ruleId: 'rule-1', ruleName: 'Podpora',
    sessionId: 'session-1', status: 'dispatched', statusDetail: null, ...overrides,
  };
}

function draft(): OutboxItem {
  return {
    id: 'out-1', account_id: 'acc', session_id: 'session-1', in_reply_to_message_id: 'msg-1', to_address: 'jana@seznam.cz',
    subject: 'Re: Kde je objednávka', text: 'Dobrý den, je na cestě.', action: 'reply', status: 'draft', status_detail: null,
    external_id: null, created_by: 'agent', created_at: '2026-10-08 06:03:00', sent_at: null,
  };
}

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function renderInbox(onOpenChange = vi.fn()) {
  render(<MemoryRouter><InboxOverlay open onOpenChange={onOpenChange} summary={{ unmatched: 0, held: 1, failed: 0, drafts: 1, proposals: 0 }} /><Where /></MemoryRouter>);
  return onOpenChange;
}

afterEach(() => {
  cleanup();
  calls.length = 0;
});

describe('InboxOverlay', () => {
  it('has a visible title, counts on the tabs and marks messages whose reply waits', async () => {
    messages = [message()];
    outbox = [draft()];
    renderInbox();
    expect(screen.getByRole('heading', { name: 'Inbox' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Messages\s*1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /To send\s*1/ })).toBeTruthy();
    expect(await screen.findByText('Reply waits for you')).toBeTruthy();
  });

  it('a message the agent has opens its chat and closes the whole inbox; no second "send to agent"', async () => {
    messages = [message()];
    outbox = [draft()];
    const onOpenChange = renderInbox();
    fireEvent.click(await screen.findByText('Kde je objednávka'));
    const detail = await screen.findByRole('heading', { name: 'Message from Jana' });
    const dialog = detail.closest('[role="dialog"]') as HTMLElement;
    // The waiting reply is right there to approve.
    expect(await within(dialog).findByText(/The agent's reply/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^Send to agent$/ })).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: /Open the agent's chat/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/session/session-1'));
  });

  it('escape over a message closes the message, not the inbox', async () => {
    messages = [message()];
    outbox = [];
    const onOpenChange = renderInbox();
    fireEvent.click(await screen.findByText('Kde je objednávka'));
    await screen.findByRole('heading', { name: 'Message from Jana' });
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Message from Jana' })).toBeNull());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('a held message explains why and offers to send it to the agent', async () => {
    messages = [message({ status: 'held', sessionId: null })];
    outbox = [];
    renderInbox();
    fireEvent.click(await screen.findByText('Kde je objednávka'));
    expect(await screen.findByText(/The rule waits for you/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Send to agent$/ }));
    await waitFor(() => expect(calls.find((call) => call.name === 'dispatch')?.args).toEqual(['msg-1', { ruleId: 'rule-1' }]));
  });
});

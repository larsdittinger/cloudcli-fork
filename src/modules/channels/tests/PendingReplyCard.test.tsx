import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import PendingReplyCard from '@/modules/channels/chat/PendingReplyCard';
import type { OutboxItem } from '@/modules/channels/types';

function item(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: 'out-1',
    account_id: 'acc',
    session_id: 'session',
    in_reply_to_message_id: 'msg',
    to_address: 'jan@firma.cz',
    subject: 'Re: Objednavka',
    text: 'Dobry den, potvrzuji.',
    status: 'draft',
    status_detail: null,
    external_id: null,
    created_by: 'agent',
    created_at: new Date().toISOString(),
    sent_at: null,
    ...overrides,
  };
}

describe('PendingReplyCard', () => {
  it('lets the user edit a draft and sends the edited text', () => {
    const onApprove = vi.fn();
    render(<PendingReplyCard item={item()} busy={false} onApprove={onApprove} onDiscard={vi.fn()} onRetry={vi.fn()} />);

    const textarea = screen.getByLabelText('Reply text') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Dobry den, potvrzuji.');
    fireEvent.change(textarea, { target: { value: 'Dobry den, potvrzuji objednavku.' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(onApprove).toHaveBeenCalledWith('out-1', 'Dobry den, potvrzuji objednavku.');
  });

  it('shows the failure and offers a retry', () => {
    const onRetry = vi.fn();
    render(<PendingReplyCard item={item({ status: 'failed', status_detail: 'smtp down' })} busy={false} onApprove={vi.fn()} onDiscard={vi.fn()} onRetry={onRetry} />);

    expect(screen.getByText('smtp down')).toBeTruthy();
    expect(screen.queryByLabelText('Reply text')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledWith('out-1');
  });

  it('renders a sent reply read-only without actions', () => {
    render(<PendingReplyCard item={item({ status: 'sent', sent_at: new Date().toISOString() })} busy={false} onApprove={vi.fn()} onDiscard={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText('Reply sent')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /send/i })).toBeNull();
  });
});

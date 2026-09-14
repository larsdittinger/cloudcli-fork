import { useCallback, useEffect, useState } from 'react';
import { Loader2, RotateCcw, Send, Trash2, X } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle, Pill, PillBar } from '@/shared/ui';
import { cn } from '@/shared/utils';
import {
  ChannelIcon,
  FIELD_CLASS,
  MessageStatusBadge,
  OutboxStatusBadge,
  formatWhen,
} from '@/modules/channels/ChannelBits';
import MessageDetail from '@/modules/channels/inbox/MessageDetail';
import { useChannelsEvents } from '@/modules/channels/hooks/useChannelsEvents';
import type { ChannelAccount, ChannelMessage, MessageStatus, OutboxItem } from '@/modules/channels/types';

type Props = { open: boolean; onOpenChange: (open: boolean) => void };

type Tab = 'messages' | 'outbox';

const MESSAGE_FILTERS: Array<{ value: MessageStatus | ''; label: string }> = [
  { value: '', label: 'All' },
  { value: 'unmatched', label: 'No rule' },
  { value: 'queued', label: 'Queued' },
  { value: 'dispatched', label: 'Agent started' },
  { value: 'failed', label: 'Failed' },
  { value: 'ignored', label: 'Ignored' },
];

function MessagesTab({ accounts }: { accounts: ChannelAccount[] }) {
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<MessageStatus | ''>('');
  const [accountId, setAccountId] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const query = new URLSearchParams({ limit: '100' });
    if (status) query.set('status', status);
    if (accountId) query.set('accountId', accountId);
    try {
      const data = await readApiJson<{ data: ChannelMessage[] }>(await api.channels.messages(`?${query.toString()}`));
      setMessages(data.data);
    } finally {
      setLoading(false);
    }
  }, [status, accountId]);

  useEffect(() => { void load(); }, [load]);
  useChannelsEvents(() => { void load(); });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <select aria-label="Status filter" className={cn(FIELD_CLASS, 'w-auto')} value={status} onChange={(event) => setStatus(event.target.value as MessageStatus | '')}>
          {MESSAGE_FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
        </select>
        {accounts.length > 1 && (
          <select aria-label="Account filter" className={cn(FIELD_CLASS, 'w-auto')} value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">All accounts</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
          </select>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</div>
      ) : messages.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Nothing here yet. Messages arrive once an account is connected.</p>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto rounded-md border border-border/60">
          {messages.map((message) => (
            <li key={message.id}>
              <button
                type="button"
                className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-accent/50"
                onClick={() => setSelectedId(message.id)}
              >
                <ChannelIcon channel={message.channel} className="mt-0.5 flex-shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="truncate text-sm font-medium">{message.from.name || message.from.address}</span>
                    <span className="text-xs text-muted-foreground">{formatWhen(message.receivedAt)}</span>
                    <MessageStatusBadge status={message.status} />
                    {message.ruleName && <span className="text-xs text-muted-foreground">{message.ruleName}</span>}
                  </div>
                  <div className="truncate text-sm text-muted-foreground">{message.subject || message.text.slice(0, 120)}</div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={selectedId !== null} onOpenChange={(next) => { if (!next) setSelectedId(null); }}>
        <DialogContent wrapperClassName="z-[10000]" className="max-w-none max-h-[85vh] w-[min(100vw-2rem,48rem)] overflow-y-auto p-4">
          <DialogTitle className="mb-2 text-base font-semibold">Inbound message</DialogTitle>
          {selectedId && <MessageDetail messageId={selectedId} onClose={() => setSelectedId(null)} onChanged={() => { void load(); }} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OutboxTab() {
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await readApiJson<{ data: OutboxItem[] }>(await api.channels.outbox('?status=draft,failed,sending,sent&limit=100'));
      setItems(data.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useChannelsEvents(() => { void load(); });

  const act = async (id: string, action: () => Promise<Response>) => {
    setBusyId(id);
    try {
      await readApiJson(await action());
    } finally {
      setBusyId(null);
      await load();
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</div>;
  }
  if (items.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No outgoing messages. Drafts appear here when an agent replies.</p>;
  }

  return (
    <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto">
      {items.map((item) => {
        const editable = item.status === 'draft';
        const text = texts[item.id] ?? item.text;
        return (
          <li key={item.id} className="rounded-md border border-border/60 p-3 text-sm">
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="text-foreground">To {item.to_address}</span>
              {item.subject && <span>· {item.subject}</span>}
              <OutboxStatusBadge status={item.status} />
              <span>{formatWhen(item.sent_at ?? item.created_at)}</span>
              <span>· by {item.created_by}</span>
            </div>
            {editable ? (
              <textarea
                aria-label="Message text"
                className={cn(FIELD_CLASS, 'min-h-[64px] resize-y')}
                value={text}
                disabled={busyId === item.id}
                onChange={(event) => setTexts((current) => ({ ...current, [item.id]: event.target.value }))}
              />
            ) : (
              <p className="whitespace-pre-wrap">{item.text}</p>
            )}
            {item.status === 'failed' && item.status_detail && <p className="mt-1 text-xs text-red-600 dark:text-red-300">{item.status_detail}</p>}
            {(editable || item.status === 'failed') && (
              <div className="mt-2 flex justify-end gap-2">
                <Button size="sm" variant="ghost" disabled={busyId === item.id} onClick={() => act(item.id, () => api.channels.discardOutbox(item.id))}>
                  <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden /> Discard
                </Button>
                {item.status === 'failed' ? (
                  <Button size="sm" disabled={busyId === item.id} onClick={() => act(item.id, () => api.channels.retryOutbox(item.id))}>
                    <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden /> Retry
                  </Button>
                ) : (
                  <Button size="sm" disabled={busyId === item.id || !text.trim()} onClick={() => act(item.id, () => api.channels.approveOutbox(item.id, { text }))}>
                    <Send className="mr-1 h-3.5 w-3.5" aria-hidden /> Send
                  </Button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The admin's inbox: every message the channels received, and everything agents want to send. */
export default function InboxOverlay({ open, onOpenChange }: Props) {
  const [tab, setTab] = useState<Tab>('messages');
  const [accounts, setAccounts] = useState<ChannelAccount[]>([]);

  useEffect(() => {
    if (!open) return;
    api.channels.accounts()
      .then((response) => readApiJson<{ data: ChannelAccount[] }>(response))
      .then((data) => setAccounts(data.data))
      .catch(() => setAccounts([]));
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wrapperClassName="z-[10000]" className="max-w-none flex h-[min(90vh,52rem)] w-[min(100vw-1rem,56rem)] flex-col gap-3 p-4 md:p-5">
        <div className="flex items-center justify-between gap-3">
          <DialogTitle className="text-base font-semibold">Inbox</DialogTitle>
          <div className="flex items-center gap-2">
            <PillBar>
              <Pill isActive={tab === 'messages'} onClick={() => setTab('messages')}>Messages</Pill>
              <Pill isActive={tab === 'outbox'} onClick={() => setTab('outbox')}>To send</Pill>
            </PillBar>
            <Button variant="ghost" size="icon" aria-label="Close" onClick={() => onOpenChange(false)}>
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
        {tab === 'messages' ? <MessagesTab accounts={accounts} /> : <OutboxTab />}
      </DialogContent>
    </Dialog>
  );
}

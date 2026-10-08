import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, ShieldAlert, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { api, readApiJson } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle, Pill, PillBar } from '@/shared/ui';
import { cn } from '@/shared/utils';
import { ChannelIcon, FIELD_CLASS, MessageStatusBadge, formatWhen } from '@/modules/channels/ChannelBits';
import PendingReplyCard from '@/modules/channels/chat/PendingReplyCard';
import MessageDetail from '@/modules/channels/inbox/MessageDetail';
import { isQuarantined } from '@/modules/channels/utils/injection';
import { useChannelsEvents } from '@/modules/channels/hooks/useChannelsEvents';
import { useOutboxActions } from '@/modules/channels/hooks/useOutboxActions';
import type { ChannelAccount, ChannelMessage, ChannelsSummary, MessageStatus, OutboxItem } from '@/modules/channels/types';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Badge counts, shown on the tabs. */
  summary?: Pick<ChannelsSummary, 'unmatched' | 'held' | 'failed' | 'drafts' | 'proposals'>;
  /** A message to open right away (`?inbox=<id>` from a notification). */
  initialMessageId?: string | null;
};

type Tab = 'messages' | 'outbox';

const MESSAGE_FILTERS: Array<{ value: MessageStatus | ''; label: string }> = [
  { value: '', label: 'All' },
  { value: 'held', label: 'Waits for you' },
  { value: 'unmatched', label: 'No rule' },
  { value: 'failed', label: 'Failed' },
  { value: 'dispatched', label: 'With the agent' },
  { value: 'queued', label: 'Queued for the agent' },
  { value: 'task', label: 'With a task' },
  { value: 'ignored', label: 'Ignored' },
];

function Count({ value }: { value: number }) {
  if (value <= 0) return null;
  return <span className="ml-1 rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold leading-4 text-white">{value > 99 ? '99+' : value}</span>;
}

function MessagesTab({ accounts, onOpenChat, onDetailOpen, initialMessageId }: {
  accounts: ChannelAccount[];
  initialMessageId?: string | null;
  onOpenChat: (sessionId: string) => void;
  /** Tells the inbox a message is open above it, so Escape closes only that. */
  onDetailOpen: (open: boolean) => void;
}) {
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [drafts, setDrafts] = useState<OutboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<MessageStatus | ''>('');
  const [accountId, setAccountId] = useState('');
  const [selectedId, setSelectedIdState] = useState<string | null>(initialMessageId ?? null);
  const setSelectedId = (id: string | null) => {
    setSelectedIdState(id);
    onDetailOpen(id !== null);
  };

  const load = useCallback(async () => {
    const query = new URLSearchParams({ limit: '100' });
    if (status) query.set('status', status);
    if (accountId) query.set('accountId', accountId);
    try {
      const [messageData, draftData] = await Promise.all([
        readApiJson<{ data: ChannelMessage[] }>(await api.channels.messages(`?${query.toString()}`)),
        readApiJson<{ data: OutboxItem[] }>(await api.channels.outbox('?status=draft,failed&limit=200')),
      ]);
      setMessages(messageData.data);
      setDrafts(draftData.data);
    } finally {
      setLoading(false);
    }
  }, [status, accountId]);

  useEffect(() => { void load(); }, [load]);
  useChannelsEvents(() => { void load(); });
  // A linked message opens above the list; the inbox must know, so Escape closes only the message.
  useEffect(() => {
    if (initialMessageId) onDetailOpen(true);
  }, [initialMessageId, onDetailOpen]);

  // Which messages have a reply waiting for approval.
  const waitingReply = useMemo(() => new Set(drafts.map((item) => item.in_reply_to_message_id).filter(Boolean)), [drafts]);

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
        <p className="py-8 text-center text-sm text-muted-foreground">{status ? 'No messages with this status.' : 'Nothing here yet. Messages arrive once an account is connected.'}</p>
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
                    {isQuarantined(message) && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-red-500/40 bg-red-500/10 px-1.5 text-[11px] font-medium text-red-700 dark:text-red-300">
                        <ShieldAlert className="h-3 w-3" aria-hidden /> Possible prompt injection
                      </span>
                    )}
                    {waitingReply.has(message.id) && (
                      <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">Reply waits for you</span>
                    )}
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
          {selectedId && (
            <MessageDetail
              messageId={selectedId}
              onClose={() => setSelectedId(null)}
              onChanged={() => { void load(); }}
              onOpenChat={onOpenChat}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OutboxTab({ onOpenChat }: { onOpenChat: (sessionId: string) => void }) {
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [loading, setLoading] = useState(true);

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
  const outbox = useOutboxActions(load);

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</div>;
  }
  if (items.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No outgoing messages. Drafts appear here when an agent replies.</p>;
  }

  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
      {outbox.error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{outbox.error}</p>}
      {items.map((item) => (
        <PendingReplyCard
          key={item.id}
          item={item}
          busy={outbox.busyId === item.id}
          onApprove={outbox.approve}
          onDiscard={outbox.discard}
          onRetry={outbox.retry}
          onOpenChat={onOpenChat}
        />
      ))}
    </div>
  );
}

/** The admin's inbox: every message the channels received, and everything agents want to send. */
export default function InboxOverlay({ open, onOpenChange, summary, initialMessageId }: Props) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('messages');
  const [accounts, setAccounts] = useState<ChannelAccount[]>([]);
  // A message detail is open above the list.
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.channels.accounts()
      .then((response) => readApiJson<{ data: ChannelAccount[] }>(response))
      .then((data) => setAccounts(data.data))
      .catch(() => setAccounts([]));
  }, [open]);

  // Leaving for a chat closes the inbox too; otherwise it would stay over the chat it opened.
  const openChat = useCallback((sessionId: string) => {
    setDetailOpen(false);
    onOpenChange(false);
    navigate(`/session/${sessionId}`);
  }, [navigate, onOpenChange]);

  const needsYou = (summary?.unmatched ?? 0) + (summary?.held ?? 0) + (summary?.failed ?? 0);
  const proposals = summary?.proposals ?? 0;

  return (
    // Escape reaches every open dialog; with a message open it closes only that message.
    <Dialog open={open} onOpenChange={(next) => { if (next || !detailOpen) onOpenChange(next); }}>
      <DialogContent wrapperClassName="z-[10000]" className="max-w-none flex h-[min(90vh,52rem)] w-[min(100vw-1rem,56rem)] flex-col gap-3 p-4 md:p-5">
        <div className="flex items-center gap-3">
          <DialogTitle className="not-sr-only text-base font-semibold">Inbox</DialogTitle>
          <PillBar aria-label="Inbox view">
            <Pill isActive={tab === 'messages'} aria-pressed={tab === 'messages'} onClick={() => setTab('messages')}>
              Messages<Count value={needsYou} />
            </Pill>
            <Pill isActive={tab === 'outbox'} aria-pressed={tab === 'outbox'} onClick={() => setTab('outbox')}>
              To send<Count value={summary?.drafts ?? 0} />
            </Pill>
          </PillBar>
          <Button variant="ghost" size="icon" className="ml-auto shrink-0" aria-label="Close" onClick={() => onOpenChange(false)}>
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        {proposals > 0 && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            {proposals === 1 ? 'An agent proposed' : `Agents proposed ${proposals} items of`} channel setup — review and approve in Settings → Channels.
          </p>
        )}
        {tab === 'messages' ? <MessagesTab accounts={accounts} onOpenChat={openChat} onDetailOpen={setDetailOpen} initialMessageId={initialMessageId} /> : <OutboxTab onOpenChat={openChat} />}
      </DialogContent>
    </Dialog>
  );
}

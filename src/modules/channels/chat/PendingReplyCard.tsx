import { useEffect, useState } from 'react';
import { Loader2, RotateCcw, Send, Trash2 } from 'lucide-react';

import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';
import { FIELD_CLASS, OutboxStatusBadge, formatWhen } from '@/modules/channels/ChannelBits';
import type { OutboxItem } from '@/modules/channels/types';

type PendingReplyCardProps = {
  item: OutboxItem;
  busy: boolean;
  onApprove: (id: string, text: string) => void;
  onDiscard: (id: string) => void;
  onRetry: (id: string) => void;
};

/** One outgoing reply an agent drafted: editable until it is sent, with the outcome shown afterwards. */
export default function PendingReplyCard({ item, busy, onApprove, onDiscard, onRetry }: PendingReplyCardProps) {
  const [text, setText] = useState(item.text);
  useEffect(() => { setText(item.text); }, [item.id, item.text]);

  const editable = item.status === 'draft';
  const sent = item.status === 'sent';

  return (
    <div
      data-testid="pending-reply-card"
      className={cn(
        'mx-3 mb-2 rounded-lg border px-3 py-2 text-sm shadow-sm',
        sent ? 'border-emerald-500/30 bg-emerald-500/5' : item.status === 'failed' ? 'border-red-500/30 bg-red-500/5' : 'border-amber-500/30 bg-amber-500/5',
      )}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{sent ? 'Reply sent' : 'Reply from the agent'}</span>
        <span>to {item.to_address}</span>
        {item.subject && <span className="truncate">· {item.subject}</span>}
        <OutboxStatusBadge status={item.status} />
        {sent && item.sent_at && <span>{formatWhen(item.sent_at)}</span>}
      </div>

      {editable ? (
        <textarea
          aria-label="Reply text"
          className={cn(FIELD_CLASS, 'min-h-[72px] resize-y')}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={busy}
        />
      ) : (
        <p className="whitespace-pre-wrap text-foreground/90">{item.text}</p>
      )}

      {item.status === 'failed' && item.status_detail && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-300">{item.status_detail}</p>
      )}

      {!sent && item.status !== 'discarded' && (
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDiscard(item.id)}>
            <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden /> Discard
          </Button>
          {item.status === 'failed' ? (
            <Button size="sm" disabled={busy} onClick={() => onRetry(item.id)}>
              {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden />} Retry
            </Button>
          ) : (
            <Button size="sm" disabled={busy || !text.trim()} onClick={() => onApprove(item.id, text)}>
              {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Send className="mr-1 h-3.5 w-3.5" aria-hidden />} Send
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

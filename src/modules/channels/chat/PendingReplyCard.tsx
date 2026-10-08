import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, RotateCcw, Send, ShieldCheck, Trash2 } from 'lucide-react';

import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';
import { FIELD_CLASS, OutboxStatusBadge, formatWhen } from '@/modules/channels/ChannelBits';
import type { OutboxItem } from '@/modules/channels/types';

type PendingReplyCardProps = {
  item: OutboxItem;
  busy: boolean;
  /** `trustSender`: also answer this sender without approval from now on. */
  onApprove: (id: string, text: string, trustSender?: boolean) => void;
  onDiscard: (id: string) => void;
  onRetry: (id: string) => void;
  /** Shown where the card is not inside its chat (inbox): opens the chat it belongs to. */
  onOpenChat?: (sessionId: string) => void;
  className?: string;
};

/** A customer reply of a rule-handled message: the only kind whose sender a rule can trust for next time. */
function canTrustSender(item: OutboxItem): boolean {
  return item.action === 'reply' && item.created_by === 'agent' && Boolean(item.in_reply_to_message_id) && !item.task_id;
}

/**
 * One outgoing message an agent drafted: editable until it is sent, with the
 * outcome shown afterwards. Used in the chat above the composer, in a
 * message's detail and in the inbox's "To send" list.
 */
export default function PendingReplyCard({ item, busy, onApprove, onDiscard, onRetry, onOpenChat, className }: PendingReplyCardProps) {
  const [text, setText] = useState(item.text);
  useEffect(() => { setText(item.text); }, [item.id, item.text]);

  const editable = item.status === 'draft';
  const sent = item.status === 'sent';
  const title = item.action === 'escalate'
    ? (sent ? 'Handoff published' : 'Hand off to a human')
    : sent ? 'Reply sent' : item.task_id ? `Message from task #${item.task_id}` : 'Reply drafted by the agent';

  return (
    <div
      data-testid="pending-reply-card"
      className={cn(
        'rounded-lg border px-3 py-2 text-sm shadow-sm',
        sent ? 'border-emerald-500/30 bg-emerald-500/5' : item.status === 'failed' ? 'border-red-500/30 bg-red-500/5' : 'border-amber-500/30 bg-amber-500/5',
        className,
      )}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{title}</span>
        <span>{item.action === 'escalate' ? `Internal note about ${item.to_address} — not a customer reply` : `to ${item.to_address}`}</span>
        {item.subject && <span className="min-w-0 truncate">· {item.subject}</span>}
        <OutboxStatusBadge status={item.status} />
        <span>{formatWhen(item.sent_at ?? item.created_at)}</span>
        {onOpenChat && item.session_id && (
          <button type="button" className="ml-auto inline-flex items-center gap-1 text-primary hover:underline" onClick={() => onOpenChat(item.session_id as string)}>
            Open chat <ExternalLink className="h-3 w-3" aria-hidden />
          </button>
        )}
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

      {!sent && item.status !== 'discarded' && item.status !== 'sending' && item.status !== 'approved' && (
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDiscard(item.id)}>
            <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden /> Discard
          </Button>
          {item.status === 'failed' ? (
            <Button size="sm" disabled={busy} onClick={() => onRetry(item.id)}>
              {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden />} Retry
            </Button>
          ) : (
            <>
              {canTrustSender(item) && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !text.trim()}
                  title={`Sends this reply and lets the agent answer ${item.to_address} on its own from now on (Settings → Channels → the rule).`}
                  onClick={() => onApprove(item.id, text, true)}
                >
                  <ShieldCheck className="mr-1 h-3.5 w-3.5" aria-hidden /> Send, then always for this sender
                </Button>
              )}
              <Button size="sm" disabled={busy || !text.trim()} onClick={() => onApprove(item.id, text)}>
                {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Send className="mr-1 h-3.5 w-3.5" aria-hidden />} Send
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { ExternalLink } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { ChannelIcon, channelName } from '@/modules/channels/ChannelBits';
import MessageDetail from '@/modules/channels/inbox/MessageDetail';
import PendingReplyCard from '@/modules/channels/chat/PendingReplyCard';
import { useSessionChannelContext } from '@/modules/channels/chat/useSessionChannelContext';

type Props = { sessionId: string | null; slot: 'top' | 'bottom' };

/**
 * Rendered twice by ChatInterface: the `top` slot shows where the chat came
 * from, the `bottom` slot shows replies waiting for approval above the composer.
 */
export default function ChatChannelPanel({ sessionId, slot }: Props) {
  const { origin, drafts, busyId, approve, discard, retry } = useSessionChannelContext(sessionId);
  const [showMessage, setShowMessage] = useState(false);

  if (slot === 'top') {
    if (!origin) return null;
    const { message, rule } = origin;
    const who = message.from.name ? `${message.from.name} (${message.from.address})` : message.from.address;
    return (
      <>
        <div className="flex flex-shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          <ChannelIcon channel={message.channel} className="h-3.5 w-3.5" />
          <span>From {channelName(message.channel)}</span>
          <span className="text-foreground">{who}</span>
          {message.subject && <span className="truncate">· {message.subject}</span>}
          {rule && <span className="hidden sm:inline">· rule “{rule.name}”</span>}
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 text-primary hover:underline"
            onClick={() => setShowMessage(true)}
          >
            View message <ExternalLink className="h-3 w-3" aria-hidden />
          </button>
        </div>
        <Dialog open={showMessage} onOpenChange={setShowMessage}>
          <DialogContent className="max-h-[85vh] w-[min(100vw-2rem,48rem)] overflow-y-auto p-4">
            <DialogTitle className="mb-2 text-base font-semibold">Inbound message</DialogTitle>
            <MessageDetail messageId={message.id} onClose={() => setShowMessage(false)} />
          </DialogContent>
        </Dialog>
      </>
    );
  }

  if (drafts.length === 0) return null;
  return (
    <div className="flex-shrink-0 pt-2">
      {drafts.map((item) => (
        <PendingReplyCard key={item.id} item={item} busy={busyId === item.id} onApprove={approve} onDiscard={discard} onRetry={retry} />
      ))}
    </div>
  );
}

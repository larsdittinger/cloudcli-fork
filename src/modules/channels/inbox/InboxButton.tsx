import { useState } from 'react';
import { Inbox } from 'lucide-react';

import { Button, Tooltip } from '@/shared/ui';
import { useIsAdmin } from '@/shared/hooks/useIsAdmin';
import InboxOverlay from '@/modules/channels/inbox/InboxOverlay';
import { useChannelsSummary } from '@/modules/channels/hooks/useChannelsSummary';

/** Sidebar entry to the channels inbox; the badge counts what needs a human (no rule, failed, drafts). */
export default function InboxButton() {
  const isAdmin = useIsAdmin();
  const [open, setOpen] = useState(false);
  const summary = useChannelsSummary();

  if (!isAdmin || !summary.enabled) return null;
  const count = summary.unmatched + summary.failed + summary.drafts;

  return (
    <>
      <Tooltip content="Inbox — messages from e-mail, WhatsApp and webhooks" position="bottom">
        <Button
          variant="ghost"
          size="icon"
          className="relative h-8 w-8"
          aria-label="Open channels inbox"
          onClick={() => setOpen(true)}
        >
          <Inbox className="h-4 w-4" aria-hidden />
          {count > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </Button>
      </Tooltip>
      <InboxOverlay open={open} onOpenChange={setOpen} />
    </>
  );
}

import { Mail, MessageCircle, Webhook } from 'lucide-react';

import { Badge } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { AccountStatus, ChannelType, MessageStatus, OutboxStatus } from '@/modules/channels/types';

/** Small shared pieces used by the settings tab, the inbox and the chat card. */

export function ChannelIcon({ channel, className }: { channel: ChannelType; className?: string }) {
  const Icon = channel === 'email' ? Mail : channel === 'whatsapp' ? MessageCircle : Webhook;
  return <Icon className={cn('h-4 w-4', className)} aria-hidden />;
}

export function channelName(channel: ChannelType): string {
  return channel === 'email' ? 'E-mail' : channel === 'whatsapp' ? 'WhatsApp' : 'Webhook';
}

const ACCOUNT_STATUS_CLASS: Record<AccountStatus, string> = {
  connected: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  connecting: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  needs_pairing: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  error: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
  disconnected: 'bg-muted text-muted-foreground border-border',
};

const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  needs_pairing: 'Needs pairing',
  error: 'Error',
  disconnected: 'Disconnected',
};

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  return <Badge variant="outline" className={cn('font-normal', ACCOUNT_STATUS_CLASS[status])}>{ACCOUNT_STATUS_LABEL[status]}</Badge>;
}

const MESSAGE_STATUS_CLASS: Record<MessageStatus, string> = {
  dispatched: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  manual: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  queued: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  unmatched: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',
  failed: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
  ignored: 'bg-muted text-muted-foreground border-border',
};

const MESSAGE_STATUS_LABEL: Record<MessageStatus, string> = {
  dispatched: 'Agent started',
  manual: 'Sent manually',
  queued: 'Queued',
  unmatched: 'No rule',
  failed: 'Failed',
  ignored: 'Ignored',
};

export function MessageStatusBadge({ status }: { status: MessageStatus }) {
  return <Badge variant="outline" className={cn('font-normal', MESSAGE_STATUS_CLASS[status])}>{MESSAGE_STATUS_LABEL[status]}</Badge>;
}

const OUTBOX_STATUS_CLASS: Record<OutboxStatus, string> = {
  draft: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  approved: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  sending: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  sent: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  failed: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
  discarded: 'bg-muted text-muted-foreground border-border',
};

const OUTBOX_STATUS_LABEL: Record<OutboxStatus, string> = {
  draft: 'Waiting for approval',
  approved: 'Approved',
  sending: 'Sending…',
  sent: 'Sent',
  failed: 'Failed',
  discarded: 'Discarded',
};

export function OutboxStatusBadge({ status }: { status: OutboxStatus }) {
  return <Badge variant="outline" className={cn('font-normal', OUTBOX_STATUS_CLASS[status])}>{OUTBOX_STATUS_LABEL[status]}</Badge>;
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Form control classes matching `Input` for native selects and textareas. */
export const FIELD_CLASS =
  'w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

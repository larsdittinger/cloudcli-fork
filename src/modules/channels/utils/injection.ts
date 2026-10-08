import type { ChannelMessage } from '@/modules/channels/types';

/** Held by the prompt-injection filter and not yet released: no agent has seen it. */
export function isQuarantined(message: Pick<ChannelMessage, 'injection'>): boolean {
  return Boolean(message.injection?.flagged && !message.injection.releasedAt);
}

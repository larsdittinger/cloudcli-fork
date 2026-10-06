import type { ChannelMessageRow, ChannelOutboxRow } from '@/modules/channels/types.js';

/**
 * How Channels hands conversations to long-running tasks without knowing about
 * them: the Tasks module registers these at start.
 */
export type ChannelTaskHooks = {
  /** Called for every new inbound message before the rules; returns the task id that took it, or null. */
  routeInbound: (message: ChannelMessageRow) => number | null;
  /** Called after a task's message was delivered; `threadKey` is where replies will arrive. */
  onSent: (row: ChannelOutboxRow, info: { threadKey: string | null; afterApproval: boolean }) => void;
};

let hooks: ChannelTaskHooks | null = null;

// setChannelTaskHooks: used by the Tasks module at start (null in tests that run Channels alone).
export function setChannelTaskHooks(next: ChannelTaskHooks | null): void {
  hooks = next;
}

/** Used by the channels service and the outbox to reach the registered hooks. */
export function getChannelTaskHooks(): ChannelTaskHooks | null {
  return hooks;
}

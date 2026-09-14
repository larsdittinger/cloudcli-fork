// Channels — inbound e-mail / WhatsApp / webhook messages that start agent turns.
import fs from 'node:fs';
import path from 'node:path';

import { createEmailAdapter } from './adapters/email-imap.adapter.js';
import { createWebhookAdapter } from './adapters/webhook.adapter.js';
import { createWhatsAppAdapter } from './adapters/whatsapp.adapter.js';
import { channelsService, CHANNELS_ROOT } from './channels.service.js';
import { closeChannelsDispatcher, initializeChannelsDispatcher } from './dispatcher.service.js';
import { outboxService } from './outbox.service.js';
import { channelMessagesDb } from '@/modules/database/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

export type {
  AccountStatus,
  AgentSendMode,
  ChannelAccountRow,
  ChannelMessageRow,
  ChannelOutboxRow,
  ChannelRuleRow,
  ChannelType,
  ConversationMode,
  InboundAttachment,
  InboundMessage,
  MessageStatus,
  OutboxStatus,
  PermissionMode,
  ReplyMode,
  ReplyScope,
  RuleConditions,
  RuleInput,
} from './types.js';

export { default as channelsRoutes } from './channels.routes.js';
export { default as channelsWebhookRoutes } from './channels-webhook.routes.js';
export { default as channelsMcpRoutes } from './channels-mcp.routes.js';
export { channelsService } from './channels.service.js';

/** Inbound messages and their attachments are kept this long; the inbox is a working queue, not an archive. */
const RETENTION_DAYS = 90;
const REAPER_INTERVAL_MS = 24 * 60 * 60 * 1000;

let reaperTimer: ReturnType<typeof setInterval> | null = null;

function reapOldMessages(): void {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const ids = channelMessagesDb.deleteOlderThan(cutoff);
  for (const id of ids) {
    fs.rmSync(path.join(CHANNELS_ROOT, 'attachments', id), { recursive: true, force: true });
  }
  if (ids.length) {
    console.log(`[Channels] Removed ${ids.length} messages older than ${RETENTION_DAYS} days`);
  }
}

/** Wires adapters, recovers from a restart and starts every enabled account. Called once by the server. */
export async function initializeChannels(runtime: ProviderRuntimeGateway): Promise<void> {
  channelsService.registerAdapterFactory('webhook', createWebhookAdapter);
  channelsService.registerAdapterFactory('email', createEmailAdapter);
  channelsService.registerAdapterFactory('whatsapp', (deps) => createWhatsAppAdapter(deps, {
    authDir: path.join(CHANNELS_ROOT, 'whatsapp', deps.accountId),
  }));
  channelsService.setRuntime(runtime);

  const recovered = outboxService.recoverAfterRestart();
  if (recovered) {
    console.log(`[Channels] ${recovered} outgoing message(s) were mid-send at shutdown and are marked failed`);
  }

  initializeChannelsDispatcher(runtime);
  reapOldMessages();
  reaperTimer = setInterval(reapOldMessages, REAPER_INTERVAL_MS);
  reaperTimer.unref?.();

  if (channelsService.isEnabled()) {
    await channelsService.startAll();
  }
}

export async function closeChannels(): Promise<void> {
  closeChannelsDispatcher();
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
  await channelsService.stopAll();
}

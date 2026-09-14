import type { AccountStatus, ChannelAccountRow, ChannelMessageRow, ChannelType, InboundMessage } from '@/modules/channels/types.js';

export type AdapterHooks = {
  /** Called for every message the account receives; the service deduplicates and routes it. */
  onMessage(message: InboundMessage): Promise<void>;
  onStatus(status: AccountStatus, detail?: string | null): void;
};

export type SendInput = {
  to: string;
  text: string;
  subject?: string;
  /** The inbound message this answers, so e-mail threads and WhatsApp quotes line up. */
  inReplyTo?: ChannelMessageRow | null;
};

export type AdapterDeps = {
  /** Folder for one message's attachments; created on demand. */
  attachmentsDir(messageId: string): string;
  /** Persists a config patch (e.g. the last seen IMAP UID) into the account row. */
  saveConfig(patch: Record<string, unknown>): void;
  log(message: string, extra?: unknown): void;
};

export interface ChannelAdapter {
  readonly type: ChannelType;
  start(account: ChannelAccountRow, hooks: AdapterHooks): Promise<void>;
  stop(): Promise<void>;
  send(input: SendInput): Promise<{ externalId: string }>;
  /** Verifies credentials without starting the adapter. */
  probe?(config: Record<string, unknown>, secrets: Record<string, unknown>): Promise<{ ok: boolean; detail: string }>;
  /** WhatsApp: what the UI needs to link a phone. */
  getPairing?(): { qrDataUrl: string | null; pairingCode: string | null };
  requestPairingCode?(phoneNumber: string): Promise<string>;
}

export type AdapterFactory = (deps: AdapterDeps) => ChannelAdapter;

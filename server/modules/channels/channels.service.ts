import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AdapterDeps, AdapterFactory, ChannelAdapter } from '@/modules/channels/adapters/channel-adapter.js';
import type { WebhookAdapter } from '@/modules/channels/adapters/webhook.adapter.js';
import { broadcastInboxUpdated } from '@/modules/channels/channels-broadcast.js';
import { dispatchMessage } from '@/modules/channels/dispatcher.service.js';
import { findMatchingRule } from '@/modules/channels/rules.service.js';
import { normalizeAddress } from '@/modules/channels/thread-key.js';
import { parseJson } from '@/modules/channels/types.js';
import type {
  AccountStatus,
  AgentSendMode,
  ChannelAccountRow,
  ChannelMessageRow,
  ChannelType,
  InboundMessage,
} from '@/modules/channels/types.js';
import { appConfigDb, channelAccountsDb, channelMessagesDb, channelRulesDb } from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';

const ENABLED_KEY = 'channels_enabled';
const MCP_TOKEN_KEY = 'channels_mcp_token';
export const MCP_SERVER_NAME = 'cloudcli-channels';
const CHANNEL_TYPES: ChannelType[] = ['email', 'whatsapp', 'webhook'];
const AGENT_SEND_MODES: AgentSendMode[] = ['off', 'draft', 'auto'];
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000;

export const CHANNELS_ROOT = path.join(os.homedir(), '.cloudcli', 'channels');

export type PublicAccount = {
  id: string;
  type: ChannelType;
  label: string;
  enabled: boolean;
  config: Record<string, unknown>;
  hasSecrets: boolean;
  agentSend: AgentSendMode;
  status: AccountStatus;
  statusDetail: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  webhookUrlPath?: string;
};

type RunningAdapter = {
  adapter: ChannelAdapter;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryDelay: number;
  stopped: boolean;
};

type McpRegistrar = { register(): Promise<unknown>; unregister(): Promise<unknown> };
let mcpRegistrar: McpRegistrar | null = null;

/** @internal test hook: keeps tests from touching the real ~/.claude.json. */
export function __setMcpRegistrar(next: McpRegistrar | null): void {
  mcpRegistrar = next;
}

const factories = new Map<ChannelType, AdapterFactory>();
const running = new Map<string, RunningAdapter>();
let runtime: ProviderRuntimeGateway | null = null;

function readConfig(row: ChannelAccountRow): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(row.config, {});
}

function readSecrets(row: ChannelAccountRow): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(row.secrets, {});
}

export function toPublicAccount(row: ChannelAccountRow): PublicAccount {
  const secrets = readSecrets(row);
  const config = readConfig(row);
  // The IMAP password never leaves the server; the rest of the config is what the form edits.
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    enabled: row.enabled === 1,
    config,
    hasSecrets: Object.values(secrets).some((value) => typeof value === 'string' && value.length > 0),
    agentSend: row.agent_send,
    status: row.status,
    statusDetail: row.status_detail,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.type === 'webhook' ? { webhookUrlPath: `/api/channels/webhook/${row.id}` } : {}),
  };
}

function getMcpCommand(): { command: string; args: string[] } {
  const scriptPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'channels-mcp.js');
  return { command: process.execPath, args: [scriptPath] };
}

function getMcpApiUrl(): string {
  const port = process.env.SERVER_PORT || process.env.PORT || '3001';
  return `http://127.0.0.1:${port}/api/channels-mcp`;
}

function adapterDeps(accountId: string, label: string): AdapterDeps {
  return {
    accountId,
    attachmentsDir: (messageId: string) => path.join(CHANNELS_ROOT, 'attachments', messageId),
    saveConfig: (patch) => {
      const row = channelAccountsDb.get(accountId);
      if (!row) return;
      channelAccountsDb.update(accountId, { config: { ...readConfig(row), ...patch } });
    },
    log: (message, extra) => {
      if (extra === undefined) {
        console.log(`[Channels:${label}] ${message}`);
      } else {
        console.log(`[Channels:${label}] ${message}`, extra);
      }
    },
  };
}

function requireAccount(id: string): ChannelAccountRow {
  const row = channelAccountsDb.get(id);
  if (!row) {
    throw new AppError('Channel account not found.', { code: 'CHANNEL_ACCOUNT_NOT_FOUND', statusCode: 404 });
  }
  return row;
}

function validateAccountInput(type: unknown, label: unknown, config: unknown, secrets: unknown, agentSend: unknown) {
  if (typeof type !== 'string' || !CHANNEL_TYPES.includes(type as ChannelType)) {
    throw new AppError('Unknown channel type.', { code: 'CHANNEL_TYPE_INVALID', statusCode: 400 });
  }
  if (typeof label !== 'string' || !label.trim()) {
    throw new AppError('An account needs a label.', { code: 'CHANNEL_LABEL_REQUIRED', statusCode: 400 });
  }
  if (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config))) {
    throw new AppError('config must be an object.', { code: 'CHANNEL_CONFIG_INVALID', statusCode: 400 });
  }
  if (secrets !== undefined && (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets))) {
    throw new AppError('secrets must be an object.', { code: 'CHANNEL_SECRETS_INVALID', statusCode: 400 });
  }
  if (agentSend !== undefined && !AGENT_SEND_MODES.includes(agentSend as AgentSendMode)) {
    throw new AppError('Unknown agentSend mode.', { code: 'CHANNEL_AGENT_SEND_INVALID', statusCode: 400 });
  }
  if (type === 'email') {
    const c = (config ?? {}) as Record<string, unknown>;
    for (const field of ['host', 'user']) {
      if (typeof c[field] !== 'string' || !(c[field] as string).trim()) {
        throw new AppError(`E-mail account needs "${field}".`, { code: 'CHANNEL_CONFIG_INVALID', statusCode: 400 });
      }
    }
  }
}

async function stopRunning(accountId: string): Promise<void> {
  const entry = running.get(accountId);
  if (!entry) return;
  entry.stopped = true;
  if (entry.retryTimer) clearTimeout(entry.retryTimer);
  running.delete(accountId);
  try {
    await entry.adapter.stop();
  } catch (error) {
    console.warn('[Channels] Adapter stop failed', { accountId, error: error instanceof Error ? error.message : String(error) });
  }
}

function scheduleRetry(accountId: string): void {
  const entry = running.get(accountId);
  if (!entry || entry.stopped) return;
  const delay = entry.retryDelay;
  entry.retryDelay = Math.min(entry.retryDelay * 2, RECONNECT_MAX_MS);
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null;
    void startAccountInternal(accountId, entry);
  }, delay);
  entry.retryTimer.unref?.();
}

async function startAccountInternal(accountId: string, existing?: RunningAdapter): Promise<void> {
  const row = channelAccountsDb.get(accountId);
  if (!row || row.enabled !== 1) return;
  const factory = factories.get(row.type);
  if (!factory) {
    channelAccountsDb.setStatus(accountId, 'error', `No adapter registered for ${row.type}.`);
    return;
  }

  const entry: RunningAdapter = existing ?? { adapter: factory(adapterDeps(accountId, row.label)), retryTimer: null, retryDelay: RECONNECT_MIN_MS, stopped: false };
  if (!existing) running.set(accountId, entry);

  channelAccountsDb.setStatus(accountId, 'connecting');
  try {
    await entry.adapter.start(row, {
      onMessage: async (message) => {
        await channelsService.ingest(accountId, message);
      },
      onStatus: (status, detail) => {
        channelAccountsDb.setStatus(accountId, status, detail ?? null);
        if (status === 'connected') entry.retryDelay = RECONNECT_MIN_MS;
        if (status === 'error' && !entry.stopped) scheduleRetry(accountId);
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    channelAccountsDb.setStatus(accountId, 'error', detail);
    console.warn(`[Channels:${row.label}] start failed: ${detail}`);
    scheduleRetry(accountId);
  }
}

function isSelfMessage(row: ChannelAccountRow, message: InboundMessage): boolean {
  if (message.raw.fromMe === true) return true;
  const config = readConfig(row);
  const own = [config.user, config.fromAddress, config.phoneNumber]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(normalizeAddress);
  return own.length > 0 && own.includes(normalizeAddress(message.from.address));
}

export const channelsService = {
  registerAdapterFactory(type: ChannelType, factory: AdapterFactory): void {
    factories.set(type, factory);
  },

  setRuntime(next: ProviderRuntimeGateway): void {
    runtime = next;
  },

  getRuntime(): ProviderRuntimeGateway | null {
    return runtime;
  },

  isEnabled(): boolean {
    return appConfigDb.get(ENABLED_KEY) === 'true';
  },

  getMcpToken(): string {
    let token = appConfigDb.get(MCP_TOKEN_KEY);
    if (!token) {
      token = randomBytes(24).toString('hex');
      appConfigDb.set(MCP_TOKEN_KEY, token);
    }
    return token;
  },

  async registerAgentMcp() {
    if (mcpRegistrar) return mcpRegistrar.register();
    const { command, args } = getMcpCommand();
    return providerMcpService.addMcpServerToAllProviders({
      name: MCP_SERVER_NAME,
      scope: 'user',
      transport: 'stdio',
      command,
      args,
      env: {
        CLOUDCLI_CHANNELS_MCP_TOKEN: this.getMcpToken(),
        CLOUDCLI_CHANNELS_API_URL: getMcpApiUrl(),
      },
    });
  },

  async unregisterAgentMcp() {
    if (mcpRegistrar) return mcpRegistrar.unregister();
    return providerMcpService.removeMcpServerFromAllProviders({ name: MCP_SERVER_NAME, scope: 'user' });
  },

  async setEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
    const was = this.isEnabled();
    appConfigDb.set(ENABLED_KEY, enabled ? 'true' : 'false');
    if (enabled) {
      await this.registerAgentMcp();
      await this.startAll();
    } else if (was) {
      await this.unregisterAgentMcp();
      await this.stopAll();
    }
    return { enabled };
  },

  listAccounts(): PublicAccount[] {
    return channelAccountsDb.list().map(toPublicAccount);
  },

  getAccount(id: string): PublicAccount {
    return toPublicAccount(requireAccount(id));
  },

  async createAccount(input: {
    type: unknown;
    label: unknown;
    config?: unknown;
    secrets?: unknown;
    agentSend?: unknown;
  }): Promise<PublicAccount & { secretsOnce?: Record<string, string> }> {
    validateAccountInput(input.type, input.label, input.config, input.secrets, input.agentSend);
    const type = input.type as ChannelType;
    const secrets = { ...((input.secrets ?? {}) as Record<string, unknown>) };
    const secretsOnce: Record<string, string> = {};
    if (type === 'webhook') {
      // The caller sees the token exactly once; afterwards only its presence is reported.
      secrets.token = randomBytes(24).toString('hex');
      secretsOnce.token = secrets.token as string;
    }
    const row = channelAccountsDb.create({
      type,
      label: (input.label as string).trim(),
      config: (input.config ?? {}) as Record<string, unknown>,
      secrets,
      agentSend: input.agentSend as AgentSendMode | undefined,
    });
    if (this.isEnabled()) {
      await startAccountInternal(row.id);
    }
    return { ...toPublicAccount(channelAccountsDb.get(row.id) ?? row), ...(type === 'webhook' ? { secretsOnce } : {}) };
  },

  async updateAccount(id: string, patch: {
    label?: unknown;
    enabled?: unknown;
    config?: unknown;
    secrets?: unknown;
    agentSend?: unknown;
  }): Promise<PublicAccount> {
    const row = requireAccount(id);
    validateAccountInput(row.type, patch.label ?? row.label, patch.config, patch.secrets, patch.agentSend);
    // Secrets are merged, so re-saving the form without retyping the password keeps it.
    const secrets = patch.secrets
      ? { ...readSecrets(row), ...Object.fromEntries(Object.entries(patch.secrets as Record<string, unknown>).filter(([, value]) => value !== '' && value !== null && value !== undefined)) }
      : undefined;
    const config = patch.config ? { ...readConfig(row), ...(patch.config as Record<string, unknown>) } : undefined;
    channelAccountsDb.update(id, {
      label: typeof patch.label === 'string' ? patch.label.trim() : undefined,
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : undefined,
      config,
      secrets,
      agentSend: patch.agentSend as AgentSendMode | undefined,
    });

    const needsRestart = patch.config !== undefined || patch.secrets !== undefined || typeof patch.enabled === 'boolean';
    if (needsRestart) {
      await stopRunning(id);
      const updated = requireAccount(id);
      if (updated.enabled === 1 && this.isEnabled()) {
        await startAccountInternal(id);
      } else {
        channelAccountsDb.setStatus(id, 'disconnected');
      }
    }
    return toPublicAccount(requireAccount(id));
  },

  async deleteAccount(id: string): Promise<void> {
    requireAccount(id);
    await stopRunning(id);
    channelAccountsDb.delete(id);
    const authDir = path.join(CHANNELS_ROOT, 'whatsapp', id);
    fs.rmSync(authDir, { recursive: true, force: true });
  },

  async testAccount(id: string): Promise<{ ok: boolean; detail: string }> {
    const row = requireAccount(id);
    const factory = factories.get(row.type);
    if (!factory) return { ok: false, detail: `No adapter registered for ${row.type}.` };
    const adapter = running.get(id)?.adapter ?? factory(adapterDeps(id, row.label));
    if (!adapter.probe) return { ok: true, detail: 'This channel type has nothing to test.' };
    try {
      return await adapter.probe(readConfig(row), readSecrets(row));
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  },

  async reconnectAccount(id: string): Promise<PublicAccount> {
    requireAccount(id);
    await stopRunning(id);
    if (this.isEnabled()) {
      await startAccountInternal(id);
    }
    return toPublicAccount(requireAccount(id));
  },

  getPairing(id: string): { qrDataUrl: string | null; pairingCode: string | null; status: AccountStatus; statusDetail: string | null } {
    const row = requireAccount(id);
    const pairing = running.get(id)?.adapter.getPairing?.() ?? { qrDataUrl: null, pairingCode: null };
    return { ...pairing, status: row.status, statusDetail: row.status_detail };
  },

  async requestPairingCode(id: string, phoneNumber: unknown): Promise<string> {
    requireAccount(id);
    const adapter = running.get(id)?.adapter;
    if (!adapter?.requestPairingCode) {
      throw new AppError('This account cannot be paired with a code right now.', { code: 'CHANNEL_PAIRING_UNAVAILABLE', statusCode: 409 });
    }
    if (typeof phoneNumber !== 'string' || phoneNumber.replace(/\D/g, '').length < 8) {
      throw new AppError('Enter the phone number in international format.', { code: 'CHANNEL_PHONE_INVALID', statusCode: 400 });
    }
    return adapter.requestPairingCode(phoneNumber);
  },

  getAdapter(accountId: string): ChannelAdapter | null {
    return running.get(accountId)?.adapter ?? null;
  },

  /** Deduplicates, drops our own messages, matches a rule and hands the message to the dispatcher. */
  async ingest(accountId: string, message: InboundMessage): Promise<ChannelMessageRow | null> {
    const account = channelAccountsDb.get(accountId);
    if (!account) return null;

    const self = isSelfMessage(account, message);
    const row = channelMessagesDb.insert(message, self ? 'ignored' : 'unmatched');
    if (!row) return null;
    if (self) return row;

    const rule = findMatchingRule(channelRulesDb.listOrdered(), message, account);
    if (!rule) {
      broadcastInboxUpdated({ messageId: row.id, status: 'unmatched' });
      return row;
    }
    if (!runtime) {
      channelMessagesDb.setStatus(row.id, 'queued', null);
      channelMessagesDb.attachRule(row.id, rule.id, null);
      broadcastInboxUpdated({ messageId: row.id, status: 'queued' });
      return channelMessagesDb.get(row.id);
    }
    await dispatchMessage(row.id, rule.id, runtime);
    return channelMessagesDb.get(row.id);
  },

  async ingestWebhook(accountId: string, token: string, body: unknown): Promise<ChannelMessageRow> {
    const row = channelAccountsDb.get(accountId);
    if (!row || row.type !== 'webhook') {
      throw new AppError('Unknown webhook.', { code: 'WEBHOOK_NOT_FOUND', statusCode: 404 });
    }
    const expected = String(readSecrets(row).token ?? '');
    const given = Buffer.from(token);
    const wanted = Buffer.from(expected);
    if (!expected || given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
      throw new AppError('Invalid webhook token.', { code: 'WEBHOOK_TOKEN_INVALID', statusCode: 401 });
    }
    if (!this.isEnabled() || row.enabled !== 1) {
      throw new AppError('This webhook is disabled.', { code: 'WEBHOOK_DISABLED', statusCode: 503 });
    }
    const adapter = running.get(accountId)?.adapter as WebhookAdapter | undefined;
    if (!adapter || typeof adapter.ingestPayload !== 'function') {
      throw new AppError('Webhook account is not running.', { code: 'WEBHOOK_ACCOUNT_STOPPED', statusCode: 503 });
    }
    const message = await adapter.ingestPayload(body);
    const stored = channelMessagesDb.get(message.id);
    if (!stored) {
      throw new AppError('Duplicate message.', { code: 'WEBHOOK_DUPLICATE', statusCode: 409 });
    }
    return stored;
  },

  async startAll(): Promise<void> {
    for (const row of channelAccountsDb.list()) {
      if (row.enabled === 1 && !running.has(row.id)) {
        await startAccountInternal(row.id);
      }
    }
  },

  async stopAll(): Promise<void> {
    await Promise.all([...running.keys()].map((id) => stopRunning(id)));
    for (const row of channelAccountsDb.list()) {
      if (row.status !== 'disconnected') channelAccountsDb.setStatus(row.id, 'disconnected');
    }
  },
};

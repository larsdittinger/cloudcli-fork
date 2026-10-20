// Run tokens: one per sandbox process, the only credential an isolated agent holds towards the app
// (Claude proxy, MCP). In memory only: an app restart invalidates all of them, and the runtime
// starts sandbox processes anew after a restart anyway.
import crypto from 'node:crypto';

export type RunTokenPurpose = 'claude' | 'exec' | 'pty' | 'self-check';

export type RunChannelContext = { messageId: string; threadKey: string; sender: string };

export type RunTokenInput = {
  projectId: string;
  sessionId: string;
  purpose: RunTokenPurpose;
  /** Set when a Channels message started the run: MCP narrows the agent to this message's thread. */
  channel?: RunChannelContext;
  /** Set when an agent task runs: MCP narrows the agent to this task. */
  taskId?: number;
};

export type RunTokenInfo = RunTokenInput & { issuedAt: number };

const TOKEN_BYTES = 32;

// Keyed by a hash of the token: a lookup never compares secrets byte by byte.
const live = new Map<string, RunTokenInfo>();

const keyOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

const copy = (info: RunTokenInfo): RunTokenInfo => ({
  ...info,
  ...(info.channel ? { channel: { ...info.channel } } : {}),
});

export const runTokens = {
  mint(input: RunTokenInput): string {
    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    live.set(keyOf(token), copy({ ...input, issuedAt: Date.now() }));
    return token;
  },

  resolve(token: string): RunTokenInfo | null {
    if (typeof token !== 'string' || !token) return null;
    const info = live.get(keyOf(token));
    return info ? copy(info) : null;
  },

  revoke(token: string): void {
    if (typeof token === 'string' && token) live.delete(keyOf(token));
  },
};

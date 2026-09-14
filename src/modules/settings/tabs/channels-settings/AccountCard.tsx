import { useState } from 'react';
import { Check, Copy, Loader2, Pencil, Plug, RefreshCw, Trash2 } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button } from '@/shared/ui';
import { AccountStatusBadge, ChannelIcon, channelName } from '@/modules/channels';
import type { ChannelAccount } from '@/modules/channels';
import WhatsAppPairing from '@/modules/settings/tabs/channels-settings/WhatsAppPairing';

type Props = {
  account: ChannelAccount;
  /** The webhook token is shown once, right after the account is created. */
  tokenOnce?: string;
  onEdit: () => void;
  onDelete: () => Promise<void>;
  onChanged: () => void;
};

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard unavailable — the value is visible to copy by hand.
        }
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
    </Button>
  );
}

const AGENT_SEND_LABEL = { off: 'agents cannot send', draft: 'agent sends need approval', auto: 'agents send freely' } as const;

export default function AccountCard({ account, tokenOnce, onEdit, onDelete, onChanged }: Props) {
  const [busy, setBusy] = useState<'test' | 'reconnect' | 'delete' | 'toggle' | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

  const webhookUrl = account.webhookUrlPath ? `${window.location.origin}${account.webhookUrlPath}` : null;

  const test = async () => {
    setBusy('test');
    try {
      const data = await readApiJson<{ data: { ok: boolean; detail: string } }>(await api.channels.testAccount(account.id));
      setTestResult(data.data);
    } catch (err) {
      setTestResult({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const reconnect = async () => {
    setBusy('reconnect');
    try {
      await readApiJson(await api.channels.reconnectAccount(account.id));
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  const toggle = async () => {
    setBusy('toggle');
    try {
      await readApiJson(await api.channels.updateAccount(account.id, { enabled: !account.enabled }));
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete “${account.label}”? Rules pointing at it stop matching.`)) return;
    setBusy('delete');
    try {
      await onDelete();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-muted">
          <ChannelIcon channel={account.type} className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{account.label}</span>
            <span className="text-xs text-muted-foreground">{channelName(account.type)}</span>
            <AccountStatusBadge status={account.enabled ? account.status : 'disconnected'} />
            {!account.enabled && <span className="text-xs text-muted-foreground">(paused)</span>}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {account.type === 'email' && <span>{String(account.config.user ?? '')} · {String(account.config.host ?? '')}</span>}
            {account.type === 'whatsapp' && <span>{String(account.config.phoneNumber ?? 'number not set')}</span>}
            {account.type === 'webhook' && <span>POST JSON to the URL below</span>}
            <span> · {AGENT_SEND_LABEL[account.agentSend]}</span>
          </div>
          {account.statusDetail && account.status !== 'needs_pairing' && (
            <p className={`mt-1 text-xs ${account.status === 'error' ? 'text-red-600 dark:text-red-300' : 'text-muted-foreground'}`}>{account.statusDetail}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {account.type !== 'webhook' && (
            <Button size="sm" variant="ghost" onClick={test} disabled={busy !== null} aria-label="Test connection">
              {busy === 'test' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plug className="h-3.5 w-3.5" aria-hidden />}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={reconnect} disabled={busy !== null || !account.enabled} aria-label="Reconnect">
            {busy === 'reconnect' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy !== null} aria-label="Edit"><Pencil className="h-3.5 w-3.5" aria-hidden /></Button>
          <Button size="sm" variant="ghost" onClick={toggle} disabled={busy !== null}>{account.enabled ? 'Pause' : 'Resume'}</Button>
          <Button size="sm" variant="ghost" onClick={remove} disabled={busy !== null} aria-label="Delete">
            {busy === 'delete' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Trash2 className="h-3.5 w-3.5" aria-hidden />}
          </Button>
        </div>
      </div>

      {testResult && (
        <p className={`mt-2 text-xs ${testResult.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600 dark:text-red-300'}`}>{testResult.detail}</p>
      )}

      {webhookUrl && (
        <div className="mt-2 space-y-1 text-xs">
          <div className="flex items-center gap-1">
            <code className="truncate rounded bg-muted px-1.5 py-0.5">{webhookUrl}</code>
            <CopyButton value={webhookUrl} label="Copy webhook URL" />
          </div>
          {tokenOnce ? (
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">Token (shown once):</span>
              <code className="truncate rounded bg-muted px-1.5 py-0.5">{tokenOnce}</code>
              <CopyButton value={tokenOnce} label="Copy webhook token" />
            </div>
          ) : (
            <p className="text-muted-foreground">Send with <code>Authorization: Bearer &lt;token&gt;</code> and a JSON body <code>{'{ from, text, subject?, name?, id?, thread? }'}</code>.</p>
          )}
        </div>
      )}

      {account.type === 'whatsapp' && account.enabled && account.status === 'needs_pairing' && (
        <WhatsAppPairing accountId={account.id} phoneNumber={typeof account.config.phoneNumber === 'string' ? account.config.phoneNumber : undefined} onPaired={onChanged} />
      )}
    </div>
  );
}

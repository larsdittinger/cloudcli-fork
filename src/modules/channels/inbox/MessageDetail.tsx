import { useCallback, useEffect, useState } from 'react';
import { Loader2, Paperclip, Play, EyeOff } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { api, readApiJson } from '@/shared/api';
import { Button } from '@/shared/ui';
import { ChannelIcon, channelName, FIELD_CLASS, MessageStatusBadge, formatWhen } from '@/modules/channels/ChannelBits';
import type { ChannelMessage, ChannelRule } from '@/modules/channels/types';

type Props = {
  messageId: string;
  onClose?: () => void;
  onChanged?: () => void;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Full view of one inbound message with the manual actions (send to an agent, ignore, open the chat). */
export default function MessageDetail({ messageId, onClose, onChanged }: Props) {
  const navigate = useNavigate();
  const [message, setMessage] = useState<ChannelMessage | null>(null);
  const [rules, setRules] = useState<ChannelRule[]>([]);
  const [ruleId, setRuleId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [messageData, rulesData] = await Promise.all([
      readApiJson<{ data: ChannelMessage }>(await api.channels.message(messageId)),
      readApiJson<{ data: ChannelRule[] }>(await api.channels.rules()),
    ]);
    setMessage(messageData.data);
    setRules(rulesData.data);
    setRuleId((current) => current || messageData.data.ruleId || rulesData.data[0]?.id || '');
  }, [messageId]);

  useEffect(() => {
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [load]);

  const act = async (action: () => Promise<Response>) => {
    setBusy(true);
    setError(null);
    try {
      await readApiJson(await action());
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!message) {
    return error
      ? <p className="text-sm text-red-600 dark:text-red-300">{error}</p>
      : <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</div>;
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <ChannelIcon channel={message.channel} />
        <span>{channelName(message.channel)}{message.accountLabel ? ` · ${message.accountLabel}` : ''}</span>
        <span>· {formatWhen(message.receivedAt)}</span>
        <MessageStatusBadge status={message.status} />
        {message.ruleName && <span>· rule “{message.ruleName}”</span>}
      </div>

      <div className="grid gap-1">
        <div><span className="text-muted-foreground">From:</span> {message.from.name ? `${message.from.name} <${message.from.address}>` : message.from.address}</div>
        {message.to.length > 0 && <div><span className="text-muted-foreground">To:</span> {message.to.join(', ')}</div>}
        {message.subject && <div><span className="text-muted-foreground">Subject:</span> {message.subject}</div>}
        {message.isGroup && <div className="text-muted-foreground">Group chat</div>}
      </div>

      <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-muted/40 p-3 font-sans text-sm">{message.text || '(no text)'}</pre>

      {message.attachments.length > 0 && (
        <ul className="space-y-1">
          {message.attachments.map((attachment) => (
            <li key={attachment.index}>
              <a
                className="inline-flex items-center gap-1 text-primary hover:underline"
                href={api.channels.attachmentUrl(message.id, attachment.index)}
                target="_blank"
                rel="noreferrer"
              >
                <Paperclip className="h-3.5 w-3.5" aria-hidden /> {attachment.name} <span className="text-muted-foreground">({formatSize(attachment.size)})</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {message.statusDetail && (
        <p className={message.status === 'failed' ? 'text-red-600 dark:text-red-300' : 'text-muted-foreground'}>{message.statusDetail}</p>
      )}
      {error && <p className="text-red-600 dark:text-red-300">{error}</p>}

      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
        {message.sessionId && (
          <Button size="sm" variant="outline" onClick={() => { onClose?.(); navigate(`/session/${message.sessionId}`); }}>
            Open chat
          </Button>
        )}
        {rules.length > 0 && (
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <select aria-label="Rule" className={`${FIELD_CLASS} w-auto min-w-40 flex-1`} value={ruleId} onChange={(event) => setRuleId(event.target.value)} disabled={busy}>
              {rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name} → {rule.projectPath.split('/').pop()}</option>)}
            </select>
            <Button size="sm" disabled={busy || !ruleId} onClick={() => act(() => api.channels.dispatchMessage(message.id, { ruleId }))}>
              {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="mr-1 h-3.5 w-3.5" aria-hidden />} Send to agent
            </Button>
          </div>
        )}
        {message.status !== 'ignored' && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => api.channels.ignoreMessage(message.id))}>
            <EyeOff className="mr-1 h-3.5 w-3.5" aria-hidden /> Ignore
          </Button>
        )}
      </div>
    </div>
  );
}

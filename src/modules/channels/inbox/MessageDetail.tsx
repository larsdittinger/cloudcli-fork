import { useCallback, useEffect, useState } from 'react';
import { EyeOff, Loader2, MessageSquare, Paperclip, Play, ShieldCheck, X } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button, DialogTitle } from '@/shared/ui';
import { ChannelIcon, channelName, FIELD_CLASS, MessageStatusBadge, formatWhen } from '@/modules/channels/ChannelBits';
import PendingReplyCard from '@/modules/channels/chat/PendingReplyCard';
import InjectionNotice from '@/modules/channels/inbox/InjectionNotice';
import { isQuarantined } from '@/modules/channels/utils/injection';
import { useOutboxActions } from '@/modules/channels/hooks/useOutboxActions';
import type { ChannelMessage, ChannelRule, MessageStatus, OutboxItem } from '@/modules/channels/types';

type Props = {
  messageId: string;
  onClose?: () => void;
  onChanged?: () => void;
  /** Goes to the message's chat and closes every overlay on the way; absent when the detail is shown inside that chat. */
  onOpenChat?: (sessionId: string) => void;
};

/** Statuses where the agent already has (or is getting) the message. */
const WITH_AGENT: MessageStatus[] = ['dispatched', 'manual', 'queued', 'task'];

/** Why the agent has not seen a message yet, in the owner's words. */
const WAITING_REASON: Partial<Record<MessageStatus, string>> = {
  held: 'The rule waits for you: the agent has not seen this message yet.',
  unmatched: 'No rule matched, so no agent has seen this message.',
  failed: 'Handing it to the agent failed.',
  ignored: 'You ignored this message.',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Full view of one inbound message: what came in, the replies waiting for
 * approval, and what can still be done with it. "Send to agent" hands the
 * message to an agent to work on — it never answers the sender.
 */
export default function MessageDetail({ messageId, onClose, onChanged, onOpenChat }: Props) {
  const [message, setMessage] = useState<ChannelMessage | null>(null);
  const [rules, setRules] = useState<ChannelRule[]>([]);
  const [replies, setReplies] = useState<OutboxItem[]>([]);
  const [ruleId, setRuleId] = useState('');
  // For a message the agent already has: whether the "run it again" controls are open.
  const [rerun, setRerun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [messageData, rulesData] = await Promise.all([
      readApiJson<{ data: ChannelMessage }>(await api.channels.message(messageId)),
      readApiJson<{ data: ChannelRule[] }>(await api.channels.rules()),
    ]);
    const loaded = messageData.data;
    setMessage(loaded);
    setRules(rulesData.data.filter((rule) => !rule.proposal));
    setRuleId((current) => current || loaded.ruleId || rulesData.data[0]?.id || '');
    if (loaded.sessionId) {
      const outbox = await readApiJson<{ data: OutboxItem[] }>(await api.channels.outbox(`?sessionId=${encodeURIComponent(loaded.sessionId)}&status=draft,failed,sending`));
      setReplies(outbox.data.filter((item) => item.in_reply_to_message_id === loaded.id));
    } else {
      setReplies([]);
    }
  }, [messageId]);

  useEffect(() => {
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [load]);

  const reload = useCallback(async () => {
    await load().catch(() => undefined);
    onChanged?.();
  }, [load, onChanged]);
  const outbox = useOutboxActions(reload);

  const act = async (action: () => Promise<Response>) => {
    setBusy(true);
    setError(null);
    try {
      await readApiJson(await action());
      setRerun(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <div className="mb-3 flex items-start justify-between gap-3">
      <DialogTitle className="not-sr-only text-base font-semibold">
        {message ? `Message from ${message.from.name || message.from.address}` : 'Message'}
      </DialogTitle>
      {onClose && (
        <Button variant="ghost" size="icon" className="-mr-1 -mt-1 h-8 w-8 shrink-0" aria-label="Close" onClick={onClose}>
          <X className="h-4 w-4" aria-hidden />
        </Button>
      )}
    </div>
  );

  if (!message) {
    return (
      <>
        {header}
        {error
          ? <p className="text-sm text-red-600 dark:text-red-300">{error}</p>
          : <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</div>}
      </>
    );
  }

  const withAgent = WITH_AGENT.includes(message.status);
  const quarantined = isQuarantined(message);
  const ruleOptions = rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name} → {rule.projectPath.split('/').pop()}</option>);
  const sendToAgent = (label: string) => (
    <div className="flex flex-wrap items-center gap-2">
      {rules.length > 1 && (
        <select aria-label="Rule" className={`${FIELD_CLASS} w-auto min-w-40 flex-1`} value={ruleId} onChange={(event) => setRuleId(event.target.value)} disabled={busy}>
          {ruleOptions}
        </select>
      )}
      <Button size="sm" disabled={busy || !ruleId} onClick={() => act(() => api.channels.dispatchMessage(message.id, { ruleId }))}>
        {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="mr-1 h-3.5 w-3.5" aria-hidden />} {label}
      </Button>
    </div>
  );

  return (
    <div className="text-sm">
      {header}
      <div className="space-y-3">
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

        {message.injection && <InjectionNotice scan={message.injection} quarantined={quarantined} />}

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

        {replies.length > 0 && (
          <section aria-label="Replies waiting for you" className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">The agent's reply — waits for you</h3>
            {replies.map((item) => (
              <PendingReplyCard key={item.id} item={item} busy={outbox.busyId === item.id} onApprove={outbox.approve} onDiscard={outbox.discard} onRetry={outbox.retry} />
            ))}
            {outbox.error && <p className="text-xs text-red-600 dark:text-red-300">{outbox.error}</p>}
          </section>
        )}

        {message.statusDetail && !quarantined && (
          <p className={message.status === 'failed' ? 'text-red-600 dark:text-red-300' : 'text-muted-foreground'}>{message.statusDetail}</p>
        )}
        {error && <p className="text-red-600 dark:text-red-300">{error}</p>}

        <div className="space-y-2 border-t border-border/60 pt-3">
          {withAgent ? (
            <div className="flex flex-wrap items-center gap-2">
              {message.sessionId && onOpenChat && (
                <Button size="sm" onClick={() => onOpenChat(message.sessionId as string)}>
                  <MessageSquare className="mr-1 h-3.5 w-3.5" aria-hidden /> Open the agent's chat
                </Button>
              )}
              {!rerun && rules.length > 0 && message.status !== 'task' && (
                <button type="button" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setRerun(true)}>
                  Hand it to an agent again…
                </button>
              )}
            </div>
          ) : quarantined ? (
            <div className="space-y-2">
              <Button size="sm" disabled={busy} onClick={() => act(() => api.channels.releaseMessage(message.id))}>
                {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <ShieldCheck className="mr-1 h-3.5 w-3.5" aria-hidden />} It is safe — release it
              </Button>
              <p className="text-xs text-muted-foreground">It goes where it would have gone: its task or the matching rule's agent, with a warning in the prompt. Ignore it if it is an attack.</p>
            </div>
          ) : (
            <p className="text-muted-foreground">{WAITING_REASON[message.status]}</p>
          )}

          {!quarantined && (!withAgent || rerun) && rules.length > 0 && (
            <>
              {sendToAgent(withAgent ? 'Send to agent again' : 'Send to agent')}
              <p className="text-xs text-muted-foreground">The agent gets the message to work on. Nothing goes to the sender until you approve a reply (or the rule replies on its own).</p>
            </>
          )}
          {!quarantined && !withAgent && rules.length === 0 && <p className="text-xs text-muted-foreground">Create a rule in Settings → Channels to hand messages to an agent.</p>}

          {!withAgent && message.status !== 'ignored' && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => api.channels.ignoreMessage(message.id))}>
              <EyeOff className="mr-1 h-3.5 w-3.5" aria-hidden /> Ignore
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

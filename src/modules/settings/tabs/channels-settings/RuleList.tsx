import { useState } from 'react';
import { ArrowDown, ArrowUp, FlaskConical, Loader2, Pencil, Trash2 } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Badge, Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { ChannelIcon, formatWhen } from '@/modules/channels';
import type { ChannelAccount, ChannelRule } from '@/modules/channels';

type Props = {
  rules: ChannelRule[];
  accounts: ChannelAccount[];
  onEdit: (rule: ChannelRule) => void;
  onChanged: () => void;
};

type TestRow = { messageId: string; from: string; subject: string | null; receivedAt: string; matched: boolean };

function describeTarget(rule: ChannelRule, accounts: ChannelAccount[]): string {
  if (rule.accountId) return accounts.find((account) => account.id === rule.accountId)?.label ?? 'deleted account';
  if (rule.channel) return `any ${rule.channel}`;
  return 'any account';
}

function describeConditions(rule: ChannelRule): string {
  const parts: string[] = [];
  const c = rule.conditions;
  if (c.senders?.length) parts.push(`from ${c.senders.slice(0, 3).join(', ')}${c.senders.length > 3 ? '…' : ''}`);
  else parts.push('from anyone');
  if (c.subject?.contains?.length) parts.push(`subject ~ ${c.subject.contains.join('/')}`);
  if (c.subject?.regex) parts.push(`subject /${c.subject.regex}/`);
  if (c.text?.contains?.length) parts.push(`text ~ ${c.text.contains.join('/')}`);
  if (c.text?.regex) parts.push(`text /${c.text.regex}/`);
  if (c.isGroup === true) parts.push('groups');
  if (c.isGroup === false) parts.push('DMs');
  if (c.hasAttachments === true) parts.push('with attachments');
  if (c.mentionsMe) parts.push('mentions me');
  return parts.join(' · ');
}

const REPLY_LABEL = { none: 'no replies', draft: 'drafts', auto: 'auto-reply' } as const;

export default function RuleList({ rules, accounts, onEdit, onChanged }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testing, setTesting] = useState<{ rule: ChannelRule; rows: TestRow[] } | null>(null);

  const act = async (id: string, action: () => Promise<Response>) => {
    setBusyId(id);
    try {
      await readApiJson(await action());
      onChanged();
    } finally {
      setBusyId(null);
    }
  };

  const move = async (index: number, direction: -1 | 1) => {
    const ids = rules.map((rule) => rule.id);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await act(rules[index].id, () => api.channels.reorderRules(ids));
  };

  const test = async (rule: ChannelRule) => {
    setBusyId(rule.id);
    try {
      const data = await readApiJson<{ data: { matches: TestRow[] } }>(await api.channels.testRule(rule.id));
      setTesting({ rule, rows: data.data.matches });
    } finally {
      setBusyId(null);
    }
  };

  if (rules.length === 0) {
    return <p className="text-sm text-muted-foreground">No rules yet. Without a rule, messages land in the inbox and wait for you.</p>;
  }

  return (
    <>
      <ol className="space-y-2">
        {rules.map((rule, index) => (
          <li key={rule.id} className={`rounded-lg border border-border/60 p-3 ${rule.enabled ? '' : 'opacity-60'}`}>
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex flex-col">
                <Button size="sm" variant="ghost" className="h-6 px-1" aria-label="Move up" disabled={index === 0 || busyId !== null} onClick={() => move(index, -1)}><ArrowUp className="h-3.5 w-3.5" aria-hidden /></Button>
                <Button size="sm" variant="ghost" className="h-6 px-1" aria-label="Move down" disabled={index === rules.length - 1 || busyId !== null} onClick={() => move(index, 1)}><ArrowDown className="h-3.5 w-3.5" aria-hidden /></Button>
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">#{index + 1}</span>
                  <span className="font-medium">{rule.name}</span>
                  {!rule.enabled && <Badge variant="outline" className="font-normal">disabled</Badge>}
                  {rule.permissionMode === 'bypassPermissions' && <Badge variant="outline" className="border-amber-500/40 font-normal text-amber-700 dark:text-amber-300">autonomous</Badge>}
                  <Badge variant="outline" className="font-normal">{REPLY_LABEL[rule.replyMode]}</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  {rule.channel && <ChannelIcon channel={rule.channel} className="h-3.5 w-3.5" />}
                  <span>{describeTarget(rule, accounts)}</span>
                  <span>· {describeConditions(rule)}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  → {rule.projectPath} · {rule.provider}{rule.model ? ` / ${rule.model}` : ''} · {rule.conversation === 'new' ? 'new chat each time' : `continue per ${rule.conversation}`}
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                <Button size="sm" variant="ghost" aria-label="Test rule" disabled={busyId !== null} onClick={() => test(rule)}>
                  {busyId === rule.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <FlaskConical className="h-3.5 w-3.5" aria-hidden />}
                </Button>
                <Button size="sm" variant="ghost" disabled={busyId !== null} onClick={() => act(rule.id, () => api.channels.updateRule(rule.id, { ...rule, enabled: !rule.enabled }))}>
                  {rule.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button size="sm" variant="ghost" aria-label="Edit rule" disabled={busyId !== null} onClick={() => onEdit(rule)}><Pencil className="h-3.5 w-3.5" aria-hidden /></Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Delete rule"
                  disabled={busyId !== null}
                  onClick={() => { if (window.confirm(`Delete rule “${rule.name}”?`)) void act(rule.id, () => api.channels.deleteRule(rule.id)); }}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ol>

      <Dialog open={testing !== null} onOpenChange={(next) => { if (!next) setTesting(null); }}>
        <DialogContent wrapperClassName="z-[10000]" className="max-w-none max-h-[80vh] w-[min(100vw-2rem,40rem)] overflow-y-auto p-4">
          <DialogTitle className="mb-2 text-base font-semibold">Would “{testing?.rule.name}” match?</DialogTitle>
          {testing && testing.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No messages received yet to test against.</p>
          ) : (
            <ul className="divide-y divide-border/60 text-sm">
              {testing?.rows.map((row) => (
                <li key={row.messageId} className="flex items-center gap-2 py-1.5">
                  <span className={row.matched ? 'text-emerald-600 dark:text-emerald-300' : 'text-muted-foreground'}>{row.matched ? '✓' : '✗'}</span>
                  <span className="truncate">{row.from}</span>
                  <span className="truncate text-muted-foreground">{row.subject ?? ''}</span>
                  <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">{formatWhen(row.receivedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

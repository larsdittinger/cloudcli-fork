import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle, Input } from '@/shared/ui';
import { cn } from '@/shared/utils';
import { ChannelIcon, channelName, FIELD_CLASS } from '@/modules/channels';
import type { AgentSendMode, ChannelAccount, ChannelType } from '@/modules/channels';

export type AccountFormValues = {
  type: ChannelType;
  label: string;
  agentSend: AgentSendMode;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
};

type Props = {
  open: boolean;
  account: ChannelAccount | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: AccountFormValues) => Promise<void>;
};

const GMAIL = { host: 'imap.gmail.com', port: 993, secure: true, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true };

function initialValues(account: ChannelAccount | null): AccountFormValues {
  return {
    type: account?.type ?? 'email',
    label: account?.label ?? '',
    agentSend: account?.agentSend ?? 'off',
    // A new account starts on the Gmail preset — the most common case and a template for any other IMAP host.
    config: account ? { ...account.config } : { ...GMAIL, mailbox: 'INBOX' },
    secrets: {},
  };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** Create / edit dialog for one account; secrets are write-only and left blank to keep the stored value. */
export default function AccountForm({ open, account, onOpenChange, onSubmit }: Props) {
  const [values, setValues] = useState<AccountFormValues>(() => initialValues(account));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAccountId, setLastAccountId] = useState(account?.id ?? null);

  if ((account?.id ?? null) !== lastAccountId) {
    setLastAccountId(account?.id ?? null);
    setValues(initialValues(account));
    setError(null);
  }

  const config = values.config as Record<string, string | number | boolean | undefined>;
  const setConfig = (patch: Record<string, unknown>) => setValues((current) => ({ ...current, config: { ...current.config, ...patch } }));
  const setSecret = (key: string, value: string) => setValues((current) => ({ ...current, secrets: { ...current.secrets, [key]: value } }));

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSubmit(values);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const types: ChannelType[] = ['email', 'whatsapp', 'webhook'];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wrapperClassName="z-[10000]" className="max-w-none max-h-[90vh] w-[min(100vw-1rem,36rem)] overflow-y-auto p-4 md:p-5">
        <DialogTitle className="mb-3 text-base font-semibold">{account ? `Edit ${account.label}` : 'Add account'}</DialogTitle>

        <div className="space-y-4">
          {!account && (
            <div className="grid grid-cols-3 gap-2">
              {types.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setValues((current) => ({ ...current, type, config: type === 'email' ? { ...GMAIL, mailbox: 'INBOX' } : {} }))}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-md border px-2 py-3 text-sm transition-colors',
                    values.type === type ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent/50',
                  )}
                >
                  <ChannelIcon channel={type} className="h-5 w-5" />
                  {channelName(type)}
                </button>
              ))}
            </div>
          )}

          <Field label="Label">
            <Input value={values.label} onChange={(event) => setValues((current) => ({ ...current, label: event.target.value }))} placeholder={values.type === 'email' ? 'Work Gmail' : values.type === 'whatsapp' ? 'My WhatsApp' : 'n8n hook'} />
          </Field>

          {values.type === 'email' && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                Preset:
                <Button type="button" size="sm" variant="outline" onClick={() => setConfig({ ...GMAIL })}>Gmail</Button>
                <span>Gmail needs an app password (Google account → Security → 2-step verification → App passwords).</span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="IMAP host"><Input value={String(config.host ?? '')} onChange={(event) => setConfig({ host: event.target.value })} /></Field>
                <Field label="IMAP port"><Input type="number" value={String(config.port ?? 993)} onChange={(event) => setConfig({ port: Number(event.target.value) })} /></Field>
                <Field label="User (e-mail)"><Input value={String(config.user ?? '')} onChange={(event) => setConfig({ user: event.target.value })} autoComplete="off" /></Field>
                <Field label={account?.hasSecrets ? 'Password (leave blank to keep)' : 'Password'}>
                  <Input type="password" value={values.secrets.password ?? ''} onChange={(event) => setSecret('password', event.target.value)} autoComplete="new-password" />
                </Field>
                <Field label="Mailbox" hint="Folder to watch, usually INBOX."><Input value={String(config.mailbox ?? 'INBOX')} onChange={(event) => setConfig({ mailbox: event.target.value })} /></Field>
                <Field label="From address" hint="Optional; defaults to the user."><Input value={String(config.fromAddress ?? '')} onChange={(event) => setConfig({ fromAddress: event.target.value })} /></Field>
                <Field label="SMTP host" hint="Optional; derived from the IMAP host."><Input value={String(config.smtpHost ?? '')} onChange={(event) => setConfig({ smtpHost: event.target.value })} /></Field>
                <Field label="SMTP port"><Input type="number" value={String(config.smtpPort ?? 465)} onChange={(event) => setConfig({ smtpPort: Number(event.target.value) })} /></Field>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={config.secure !== false} onChange={(event) => setConfig({ secure: event.target.checked, smtpSecure: event.target.checked })} />
                Use TLS (IMAP 993 / SMTP 465)
              </label>
            </>
          )}

          {values.type === 'whatsapp' && (
            <>
              <Field label="Phone number" hint="Optional; used for the pairing-code method and to ignore your own messages.">
                <Input value={String(config.phoneNumber ?? '')} onChange={(event) => setConfig({ phoneNumber: event.target.value })} placeholder="+420 777 123 456" />
              </Field>
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200">
                WhatsApp does not officially support linked-device automation. Use a secondary number if you can; a ban is rare but possible.
              </p>
            </>
          )}

          {values.type === 'webhook' && (
            <Field label="Reply URL" hint="Optional. Where agent replies are POSTed as JSON ({ to, text, subject, inReplyTo }). Without it the webhook is inbound only.">
              <Input value={String(config.replyUrl ?? '')} onChange={(event) => setConfig({ replyUrl: event.target.value })} placeholder="https://…" />
            </Field>
          )}

          <Field label="Agents may send new messages" hint="Replies to inbound messages are governed by the rule that handled them; this covers everything else.">
            <select className={FIELD_CLASS} value={values.agentSend} onChange={(event) => setValues((current) => ({ ...current, agentSend: event.target.value as AgentSendMode }))}>
              <option value="off">No</option>
              <option value="draft">Only as drafts I approve</option>
              <option value="auto">Yes, automatically</option>
            </select>
          </Field>

          {error && <p className="text-sm text-red-600 dark:text-red-300">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button onClick={submit} disabled={saving || !values.label.trim()}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />} {account ? 'Save' : 'Add account'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation('channels');
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
      <DialogContent wrapperClassName="z-[10000]" className="max-h-[90vh] w-[min(100vw-1rem,36rem)] max-w-none overflow-y-auto p-4 md:p-5">
        <DialogTitle className="mb-3 text-base font-semibold">{account ? t('accountForm.editTitle', { label: account.label }) : t('accountForm.addTitle')}</DialogTitle>

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

          <Field label={t('accountForm.label')}>
            <Input value={values.label} onChange={(event) => setValues((current) => ({ ...current, label: event.target.value }))} placeholder={values.type === 'email' ? t('accountForm.labelPlaceholderEmail') : values.type === 'whatsapp' ? t('accountForm.labelPlaceholderWhatsapp') : t('accountForm.labelPlaceholderWebhook')} />
          </Field>

          {values.type === 'email' && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {t('accountForm.preset')}
                <Button type="button" size="sm" variant="outline" onClick={() => setConfig({ ...GMAIL })}>Gmail</Button>
                <span>{t('accountForm.gmailHint')}</span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t('accountForm.imapHost')}><Input value={String(config.host ?? '')} onChange={(event) => setConfig({ host: event.target.value })} /></Field>
                <Field label={t('accountForm.imapPort')}><Input type="number" value={String(config.port ?? 993)} onChange={(event) => setConfig({ port: Number(event.target.value) })} /></Field>
                <Field label={t('accountForm.user')}><Input value={String(config.user ?? '')} onChange={(event) => setConfig({ user: event.target.value })} autoComplete="off" /></Field>
                <Field label={account?.hasSecrets ? t('accountForm.passwordKeep') : t('accountForm.password')}>
                  <Input type="password" value={values.secrets.password ?? ''} onChange={(event) => setSecret('password', event.target.value)} autoComplete="new-password" />
                </Field>
                <Field label={t('accountForm.mailbox')} hint={t('accountForm.mailboxHint')}><Input value={String(config.mailbox ?? 'INBOX')} onChange={(event) => setConfig({ mailbox: event.target.value })} /></Field>
                <Field label={t('accountForm.fromAddress')} hint={t('accountForm.fromAddressHint')}><Input value={String(config.fromAddress ?? '')} onChange={(event) => setConfig({ fromAddress: event.target.value })} /></Field>
                <Field label={t('accountForm.smtpHost')} hint={t('accountForm.smtpHostHint')}><Input value={String(config.smtpHost ?? '')} onChange={(event) => setConfig({ smtpHost: event.target.value })} /></Field>
                <Field label={t('accountForm.smtpPort')}><Input type="number" value={String(config.smtpPort ?? 465)} onChange={(event) => setConfig({ smtpPort: Number(event.target.value) })} /></Field>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={config.secure !== false} onChange={(event) => setConfig({ secure: event.target.checked, smtpSecure: event.target.checked })} />
                {t('accountForm.useTls')}
              </label>
            </>
          )}

          {values.type === 'whatsapp' && (
            <>
              <Field label={t('accountForm.phoneNumber')} hint={t('accountForm.phoneNumberHint')}>
                <Input value={String(config.phoneNumber ?? '')} onChange={(event) => setConfig({ phoneNumber: event.target.value })} placeholder="+420 777 123 456" />
              </Field>
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200">
                {t('accountForm.whatsappWarning')}
              </p>
            </>
          )}

          {values.type === 'webhook' && (
            <>
              <Field label={t('accountForm.replyUrl')} hint={t('accountForm.replyUrlHint')}>
                <Input value={String(config.replyUrl ?? '')} onChange={(event) => setConfig({ replyUrl: event.target.value })} placeholder="https://…" />
              </Field>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={config.allowEscalation === true} onChange={(event) => setConfig({ allowEscalation: event.target.checked })} />
                {t('accountForm.allowEscalation')}
              </label>
              <Field label={t('accountForm.callbackToken')} hint={t('accountForm.callbackTokenHint')}>
                <Input type="password" value={values.secrets.replyToken ?? ''} onChange={(event) => setSecret('replyToken', event.target.value)} autoComplete="new-password" />
              </Field>
            </>
          )}

          {values.type !== 'webhook' && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={config.autoReplyAnyone === true} onChange={(event) => setConfig({ autoReplyAnyone: event.target.checked })} />
              <span>
                {t('accountForm.autoReplyAnyone')}
                <span className="block text-xs text-muted-foreground">
                  {t('accountForm.autoReplyAnyoneDescription')}
                </span>
              </span>
            </label>
          )}

          <Field label={t('accountForm.agentSend')} hint={t('accountForm.agentSendHint')}>
            <select className={FIELD_CLASS} value={values.agentSend} onChange={(event) => setValues((current) => ({ ...current, agentSend: event.target.value as AgentSendMode }))}>
              <option value="off">{t('accountForm.agentSendOff')}</option>
              <option value="draft">{t('accountForm.agentSendDraft')}</option>
              <option value="auto">{t('accountForm.agentSendAuto')}</option>
            </select>
          </Field>

          {error && <p className="text-sm text-red-600 dark:text-red-300">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>{t('common.cancel')}</Button>
            <Button onClick={submit} disabled={saving || !values.label.trim()}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />} {account ? t('accountForm.save') : t('accountForm.add')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { Project } from '@/shared/types';
import { FIELD_CLASS } from '@/modules/channels';
import type { ChannelAccount, ChannelRule, ChannelRuleInput, ConversationMode, PermissionMode, ReplyMode, ReplyScope } from '@/modules/channels';
import { parseLines, ruleOpenAutonomyError } from '@/modules/settings/tabs/channels-settings/ruleValidation';

type Props = {
  open: boolean;
  rule: ChannelRule | null;
  accounts: ChannelAccount[];
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: ChannelRuleInput) => Promise<void>;
};

/** Prompt-template placeholders the server fills in; passed to the hint as a value so i18next leaves them alone. */
const TEMPLATE_PLACEHOLDERS = '{{channel}} {{account}} {{from}} {{fromName}} {{to}} {{subject}} {{text}} {{metadata}} {{threadKey}} {{receivedAt}} {{attachments}} {{messageId}} {{replyInstructions}}';

type FormState = {
  name: string;
  enabled: boolean;
  target: string; // '' = any account, 'type:email' = any e-mail account, otherwise an account id
  senders: string;
  excludeSenders: string;
  subjectContains: string;
  subjectRegex: string;
  textContains: string;
  textRegex: string;
  groupMode: 'any' | 'dm' | 'group';
  hasAttachments: 'any' | 'yes' | 'no';
  mentionsMe: boolean;
  projectPath: string;
  provider: string;
  model: string;
  effort: string;
  permissionMode: PermissionMode;
  promptTemplate: string;
  conversation: ConversationMode;
  replyMode: ReplyMode;
  replyScope: ReplyScope;
  autoReplySenders: string;
  holdInbound: boolean;
};

function toForm(rule: ChannelRule | null): FormState {
  const conditions = rule?.conditions ?? {};
  return {
    name: rule?.name ?? '',
    enabled: rule?.enabled ?? true,
    target: rule?.accountId ?? (rule?.channel ? `type:${rule.channel}` : ''),
    senders: (conditions.senders ?? []).join('\n'),
    excludeSenders: (conditions.excludeSenders ?? []).join('\n'),
    subjectContains: (conditions.subject?.contains ?? []).join(', '),
    subjectRegex: conditions.subject?.regex ?? '',
    textContains: (conditions.text?.contains ?? []).join(', '),
    textRegex: conditions.text?.regex ?? '',
    groupMode: conditions.isGroup === true ? 'group' : conditions.isGroup === false ? 'dm' : 'any',
    hasAttachments: conditions.hasAttachments === true ? 'yes' : conditions.hasAttachments === false ? 'no' : 'any',
    mentionsMe: conditions.mentionsMe === true,
    projectPath: rule?.projectPath ?? '',
    provider: rule?.provider ?? 'claude',
    model: rule?.model ?? '',
    effort: rule?.effort ?? '',
    permissionMode: rule?.permissionMode ?? 'default',
    promptTemplate: rule?.promptTemplate ?? '',
    conversation: rule?.conversation ?? 'thread',
    replyMode: rule?.replyMode ?? 'draft',
    replyScope: rule?.replyScope ?? 'sender',
    autoReplySenders: (rule?.autoReplySenders ?? []).join('\n'),
    holdInbound: rule?.holdInbound ?? false,
  };
}

function toInput(form: FormState): ChannelRuleInput {
  const conditions: ChannelRuleInput['conditions'] = {};
  const senders = parseLines(form.senders);
  const excludeSenders = parseLines(form.excludeSenders);
  if (senders.length) conditions.senders = senders;
  if (excludeSenders.length) conditions.excludeSenders = excludeSenders;
  const subjectContains = parseLines(form.subjectContains);
  if (subjectContains.length || form.subjectRegex.trim()) {
    conditions.subject = { ...(subjectContains.length ? { contains: subjectContains } : {}), ...(form.subjectRegex.trim() ? { regex: form.subjectRegex.trim() } : {}) };
  }
  const textContains = parseLines(form.textContains);
  if (textContains.length || form.textRegex.trim()) {
    conditions.text = { ...(textContains.length ? { contains: textContains } : {}), ...(form.textRegex.trim() ? { regex: form.textRegex.trim() } : {}) };
  }
  if (form.groupMode !== 'any') conditions.isGroup = form.groupMode === 'group';
  if (form.hasAttachments !== 'any') conditions.hasAttachments = form.hasAttachments === 'yes';
  if (form.mentionsMe) conditions.mentionsMe = true;

  return {
    name: form.name.trim(),
    enabled: form.enabled,
    accountId: form.target && !form.target.startsWith('type:') ? form.target : null,
    channel: form.target.startsWith('type:') ? (form.target.slice(5) as ChannelRuleInput['channel']) : null,
    conditions,
    projectPath: form.projectPath,
    provider: form.provider,
    model: form.model.trim() || null,
    effort: form.effort.trim() || null,
    permissionMode: form.permissionMode,
    promptTemplate: form.promptTemplate,
    conversation: form.conversation,
    replyMode: form.replyMode,
    replyScope: form.replyScope,
    autoReplySenders: form.replyMode === 'draft' ? parseLines(form.autoReplySenders) : [],
    holdInbound: form.holdInbound,
  };
}

function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('block space-y-1 text-sm', className)}>
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

export default function RuleEditor({ open, rule, accounts, onOpenChange, onSubmit }: Props) {
  const { t } = useTranslation('channels');
  const [form, setForm] = useState<FormState>(() => toForm(rule));
  const [projects, setProjects] = useState<Project[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRuleId, setLastRuleId] = useState(rule?.id ?? null);

  if ((rule?.id ?? null) !== lastRuleId) {
    setLastRuleId(rule?.id ?? null);
    setForm(toForm(rule));
    setError(null);
  }

  useEffect(() => {
    if (!open) return;
    api.projects()
      .then((response) => readApiJson<Project[] | { data: Project[] }>(response))
      .then((data) => {
        const list = Array.isArray(data) ? data : data.data;
        setProjects(list);
        setForm((current) => current.projectPath || list.length === 0 ? current : { ...current, projectPath: list[0].fullPath });
      })
      .catch(() => setProjects([]));
  }, [open]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));
  const input = toInput(form);
  const ruleAccount = accounts.find((account) => account.id === input.accountId);
  const ruleProjectIsolated = projects.some((project) => project.fullPath === input.projectPath && project.isolated === true);
  const warning = ruleOpenAutonomyError(input, ruleAccount?.config.autoReplyAnyone === true, ruleProjectIsolated);
  const openIsolatedHint = ruleProjectIsolated && input.permissionMode !== 'default'
    && (input.conditions.senders ?? []).every((sender) => !sender.trim() || sender.trim() === '*');
  const canSave = Boolean(input.name && input.projectPath) && !warning;

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSubmit(input);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wrapperClassName="z-[10000]" className="max-h-[92vh] w-[min(100vw-1rem,44rem)] max-w-none overflow-y-auto p-4 md:p-5">
        <DialogTitle className="mb-3 text-base font-semibold">{rule ? t('ruleEditor.editTitle', { name: rule.name }) : t('ruleEditor.newTitle')}</DialogTitle>

        <div className="space-y-5">
          <Field label={t('ruleEditor.name')}><Input value={form.name} onChange={(event) => set('name', event.target.value)} placeholder={t('ruleEditor.namePlaceholder')} /></Field>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{t('ruleEditor.when')}</h3>
            <Field label={t('ruleEditor.account')}>
              <select className={FIELD_CLASS} value={form.target} onChange={(event) => set('target', event.target.value)}>
                <option value="">{t('ruleEditor.anyAccount')}</option>
                <option value="type:email">{t('ruleEditor.anyEmail')}</option>
                <option value="type:whatsapp">{t('ruleEditor.anyWhatsapp')}</option>
                <option value="type:webhook">{t('ruleEditor.anyWebhook')}</option>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
              </select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('ruleEditor.senders')} hint={t('ruleEditor.sendersHint')}>
                <textarea className={cn(FIELD_CLASS, 'min-h-[72px]')} value={form.senders} onChange={(event) => set('senders', event.target.value)} />
              </Field>
              <Field label={t('ruleEditor.excludeSenders')} hint={t('ruleEditor.excludeSendersHint')}>
                <textarea className={cn(FIELD_CLASS, 'min-h-[72px]')} value={form.excludeSenders} onChange={(event) => set('excludeSenders', event.target.value)} />
              </Field>
              <Field label={t('ruleEditor.subjectContains')} hint={t('ruleEditor.containsHint')}><Input value={form.subjectContains} onChange={(event) => set('subjectContains', event.target.value)} /></Field>
              <Field label={t('ruleEditor.subjectRegex')}><Input value={form.subjectRegex} onChange={(event) => set('subjectRegex', event.target.value)} placeholder="^\\[ticket-\\d+\\]" /></Field>
              <Field label={t('ruleEditor.textContains')} hint={t('ruleEditor.containsHint')}><Input value={form.textContains} onChange={(event) => set('textContains', event.target.value)} /></Field>
              <Field label={t('ruleEditor.textRegex')}><Input value={form.textRegex} onChange={(event) => set('textRegex', event.target.value)} /></Field>
              <Field label={t('ruleEditor.chatType')}>
                <select className={FIELD_CLASS} value={form.groupMode} onChange={(event) => set('groupMode', event.target.value as FormState['groupMode'])}>
                  <option value="any">{t('ruleEditor.chatTypeAny')}</option>
                  <option value="dm">{t('ruleEditor.chatTypeDm')}</option>
                  <option value="group">{t('ruleEditor.chatTypeGroup')}</option>
                </select>
              </Field>
              <Field label={t('ruleEditor.attachments')}>
                <select className={FIELD_CLASS} value={form.hasAttachments} onChange={(event) => set('hasAttachments', event.target.value as FormState['hasAttachments'])}>
                  <option value="any">{t('ruleEditor.attachmentsAny')}</option>
                  <option value="yes">{t('ruleEditor.attachmentsYes')}</option>
                  <option value="no">{t('ruleEditor.attachmentsNo')}</option>
                </select>
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.mentionsMe} onChange={(event) => set('mentionsMe', event.target.checked)} />
              {t('ruleEditor.mentionsMe')}
            </label>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{t('ruleEditor.then')}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('ruleEditor.project')} className="sm:col-span-2">
                {projects.length > 0 ? (
                  <select className={FIELD_CLASS} value={form.projectPath} onChange={(event) => set('projectPath', event.target.value)}>
                    {!projects.some((project) => project.fullPath === form.projectPath) && form.projectPath && <option value={form.projectPath}>{form.projectPath}</option>}
                    {projects.map((project) => <option key={project.projectId} value={project.fullPath}>{project.displayName} — {project.fullPath}</option>)}
                  </select>
                ) : (
                  <Input value={form.projectPath} onChange={(event) => set('projectPath', event.target.value)} placeholder="/workspace/project" />
                )}
              </Field>
              <Field label={t('ruleEditor.provider')}>
                <select className={FIELD_CLASS} value={form.provider} onChange={(event) => set('provider', event.target.value)}>
                  <option value="claude">Claude Code</option>
                  <option value="codex">Codex</option>
                  <option value="cursor">Cursor</option>
                  <option value="opencode">OpenCode</option>
                </select>
              </Field>
              <Field label={t('ruleEditor.permissionMode')}>
                <select className={FIELD_CLASS} value={form.permissionMode} onChange={(event) => set('permissionMode', event.target.value as PermissionMode)}>
                  <option value="default">{t('ruleEditor.permissionDefault')}</option>
                  <option value="acceptEdits">{t('ruleEditor.permissionAcceptEdits')}</option>
                  <option value="plan">{t('ruleEditor.permissionPlan')}</option>
                  <option value="bypassPermissions">{t('ruleEditor.permissionBypass')}</option>
                </select>
              </Field>
              {openIsolatedHint && (
                <p className="text-xs text-muted-foreground sm:col-span-2">{t('isolation:rule.openIsolatedHint')}</p>
              )}
              <Field label={t('ruleEditor.model')} hint={t('ruleEditor.modelHint')}><Input value={form.model} onChange={(event) => set('model', event.target.value)} placeholder={t('ruleEditor.modelPlaceholder')} /></Field>
              <Field label={t('ruleEditor.effort')} hint={t('ruleEditor.effortHint')}><Input value={form.effort} onChange={(event) => set('effort', event.target.value)} placeholder="low / medium / high" /></Field>
              <Field label={t('ruleEditor.onMatch')} className="sm:col-span-2">
                <select className={FIELD_CLASS} value={form.holdInbound ? 'hold' : 'run'} onChange={(event) => set('holdInbound', event.target.value === 'hold')}>
                  <option value="run">{t('ruleEditor.onMatchRun')}</option>
                  <option value="hold">{t('ruleEditor.onMatchHold')}</option>
                </select>
              </Field>
              <Field label={t('ruleEditor.conversation')}>
                <select className={FIELD_CLASS} value={form.conversation} onChange={(event) => set('conversation', event.target.value as ConversationMode)}>
                  <option value="thread">{t('ruleEditor.conversationThread')}</option>
                  <option value="sender">{t('ruleEditor.conversationSender')}</option>
                  <option value="new">{t('ruleEditor.conversationNew')}</option>
                </select>
              </Field>
              <Field label={t('ruleEditor.replies')}>
                <select className={FIELD_CLASS} value={form.replyMode} onChange={(event) => set('replyMode', event.target.value as ReplyMode)}>
                  <option value="none">{t('ruleEditor.repliesNone')}</option>
                  <option value="draft">{t('ruleEditor.repliesDraft')}</option>
                  <option value="auto">{t('ruleEditor.repliesAuto')}</option>
                </select>
              </Field>
              {form.replyMode === 'draft' && (
                <Field
                  label={t('ruleEditor.autoReplySenders')}
                  className="sm:col-span-2"
                  hint={t('ruleEditor.autoReplySendersHint')}
                >
                  <textarea className={cn(FIELD_CLASS, 'min-h-[56px]')} value={form.autoReplySenders} onChange={(event) => set('autoReplySenders', event.target.value)} placeholder="jana@seznam.cz" />
                </Field>
              )}
              <Field label={t('ruleEditor.replyScope')}>
                <select className={FIELD_CLASS} value={form.replyScope} onChange={(event) => set('replyScope', event.target.value as ReplyScope)}>
                  <option value="sender">{t('ruleEditor.replyScopeSender')}</option>
                  <option value="anyone">{t('ruleEditor.replyScopeAnyone')}</option>
                </select>
              </Field>
            </div>
            <Field label={t('ruleEditor.promptTemplate')} hint={t('ruleEditor.promptTemplateHint', { placeholders: TEMPLATE_PLACEHOLDERS })}>
              <textarea className={cn(FIELD_CLASS, 'min-h-[120px] font-mono text-xs')} value={form.promptTemplate} onChange={(event) => set('promptTemplate', event.target.value)} placeholder={t('ruleEditor.promptTemplatePlaceholder')} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.enabled} onChange={(event) => set('enabled', event.target.checked)} />
              {t('ruleEditor.enabled')}
            </label>
          </section>

          {warning && (
            <p role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-800 dark:text-amber-200">{warning}</p>
          )}
          {error && <p className="text-sm text-red-600 dark:text-red-300">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>{t('common.cancel')}</Button>
            <Button onClick={submit} disabled={saving || !canSave}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />} {rule ? t('ruleEditor.save') : t('ruleEditor.create')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button } from '@/shared/ui';
import { useChannelsEvents } from '@/modules/channels';
import type { ChannelAccount, ChannelRule, ChannelRuleInput } from '@/modules/channels';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import AccountCard from '@/modules/settings/tabs/channels-settings/AccountCard';
import AccountForm from '@/modules/settings/tabs/channels-settings/AccountForm';
import type { AccountFormValues } from '@/modules/settings/tabs/channels-settings/AccountForm';
import RuleEditor from '@/modules/settings/tabs/channels-settings/RuleEditor';
import RuleList from '@/modules/settings/tabs/channels-settings/RuleList';

type ChannelsSettings = { enabled: boolean; mcpServerName: string; mcpError: string | null; accounts: number; rules: number };

/** Rendered by Settings for the "channels" tab: accounts, rules and the master switch. */
export default function ChannelsSettingsTab() {
  const { t } = useTranslation('settings');
  const [settings, setSettings] = useState<ChannelsSettings | null>(null);
  const [accounts, setAccounts] = useState<ChannelAccount[]>([]);
  const [rules, setRules] = useState<ChannelRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountDialog, setAccountDialog] = useState<{ open: boolean; account: ChannelAccount | null }>({ open: false, account: null });
  const [ruleDialog, setRuleDialog] = useState<{ open: boolean; rule: ChannelRule | null }>({ open: false, rule: null });
  const [tokensOnce, setTokensOnce] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [settingsData, accountsData, rulesData] = await Promise.all([
        readApiJson<{ data: ChannelsSettings }>(await api.channels.settings()),
        readApiJson<{ data: ChannelAccount[] }>(await api.channels.accounts()),
        readApiJson<{ data: ChannelRule[] }>(await api.channels.rules()),
      ]);
      setSettings(settingsData.data);
      setAccounts(accountsData.data);
      setRules(rulesData.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useChannelsEvents(() => { void load(); });

  // Account status changes (connecting → connected, QR ready) do not push a frame; poll lightly while the tab is open.
  useEffect(() => {
    if (!settings?.enabled) return;
    const timer = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(timer);
  }, [settings?.enabled, load]);

  const toggleEnabled = async (enabled: boolean) => {
    setSaving(true);
    try {
      await readApiJson(await api.channels.saveSettings({ enabled }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const submitAccount = async (values: AccountFormValues) => {
    if (accountDialog.account) {
      await readApiJson(await api.channels.updateAccount(accountDialog.account.id, {
        label: values.label,
        agentSend: values.agentSend,
        config: values.config,
        secrets: values.secrets,
      }));
    } else {
      const created = await readApiJson<{ data: ChannelAccount }>(await api.channels.createAccount(values));
      if (created.data.secretsOnce?.token) {
        setTokensOnce((current) => ({ ...current, [created.data.id]: created.data.secretsOnce!.token }));
      }
    }
    await load();
  };

  const submitRule = async (values: ChannelRuleInput) => {
    if (ruleDialog.rule) {
      await readApiJson(await api.channels.updateRule(ruleDialog.rule.id, values));
    } else {
      await readApiJson(await api.channels.createRule(values));
    }
    await load();
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</div>;
  }

  return (
    <div className="space-y-8">
      <SettingsSection title={t('channels.sectionTitle')} description={t('channels.sectionDescription')}>
        <SettingsCard>
          <SettingsRow label={t('channels.enableLabel')} description={t('channels.enableDescription')}>
            <SettingsToggle checked={Boolean(settings?.enabled)} onChange={toggleEnabled} ariaLabel={t('channels.enableLabel')} disabled={saving} />
          </SettingsRow>
        </SettingsCard>
        {settings?.enabled && settings.mcpError && (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">Agents cannot reply yet — registering the {settings.mcpServerName} MCP server failed: {settings.mcpError}</p>
        )}
        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-300">{error}</p>}
      </SettingsSection>

      <SettingsSection title={t('channels.accountsTitle')} description={t('channels.accountsDescription')}>
        <div className="space-y-2">
          {accounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              tokenOnce={tokensOnce[account.id]}
              onEdit={() => setAccountDialog({ open: true, account })}
              onDelete={async () => { await readApiJson(await api.channels.deleteAccount(account.id)); await load(); }}
              onChanged={() => { void load(); }}
            />
          ))}
          <Button variant="outline" size="sm" onClick={() => setAccountDialog({ open: true, account: null })}>
            <Plus className="mr-1 h-4 w-4" aria-hidden /> Add account
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection title={t('channels.rulesTitle')} description={t('channels.rulesDescription')}>
        <div className="space-y-3">
          <RuleList rules={rules} accounts={accounts} onEdit={(rule) => setRuleDialog({ open: true, rule })} onChanged={() => { void load(); }} />
          <Button variant="outline" size="sm" onClick={() => setRuleDialog({ open: true, rule: null })}>
            <Plus className="mr-1 h-4 w-4" aria-hidden /> New rule
          </Button>
        </div>
      </SettingsSection>

      {accountDialog.open && (
        <AccountForm
          open={accountDialog.open}
          account={accountDialog.account}
          onOpenChange={(open) => setAccountDialog((current) => ({ ...current, open }))}
          onSubmit={submitAccount}
        />
      )}
      {ruleDialog.open && (
        <RuleEditor
          open={ruleDialog.open}
          rule={ruleDialog.rule}
          accounts={accounts}
          onOpenChange={(open) => setRuleDialog((current) => ({ ...current, open }))}
          onSubmit={submitRule}
        />
      )}
    </div>
  );
}

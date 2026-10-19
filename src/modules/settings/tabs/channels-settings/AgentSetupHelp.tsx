import { Trans, useTranslation } from 'react-i18next';

import SettingsCard from '@/modules/settings/SettingsCard';

function Code({ children }: { children?: React.ReactNode }) {
  return <code className="break-all rounded bg-muted px-1 py-0.5 text-xs">{children}</code>;
}

const HELP_COMPONENTS = {
  code: <Code />,
  badge: <span className="font-medium text-amber-700 dark:text-amber-300" />,
  strong: <span className="font-medium" />,
};

// Tool names stay literal: the translation only places them (`<code>{{mcp}}</code>` etc.).
const TOOL_NAMES = {
  mcp: 'cloudcli-channels',
  getinfo: 'channels_get_info',
  proposeaccount: 'channels_propose_account',
  proposerule: 'channels_propose_rule',
  buildlink: 'channels_build_link',
};

/** Used by ChannelsSettingsTab to explain what agents can set up themselves and how prompt links work. */
export default function AgentSetupHelp() {
  const { t } = useTranslation('channels');
  const origin = window.location.origin;
  return (
    <SettingsCard>
      <div className="space-y-4 p-4 text-sm">
        <div>
          <p className="font-medium">{t('agentHelp.knowTitle')}</p>
          <p className="mt-1 text-muted-foreground">
            <Trans t={t} i18nKey="agentHelp.knowBody" values={TOOL_NAMES} components={HELP_COMPONENTS} />
          </p>
        </div>

        <div>
          <p className="font-medium">{t('agentHelp.proposalsTitle')}</p>
          <p className="mt-1 text-muted-foreground">
            <Trans t={t} i18nKey="agentHelp.proposalsBody" values={TOOL_NAMES} components={HELP_COMPONENTS} />
          </p>
        </div>

        <div>
          <p className="font-medium">{t('agentHelp.linksTitle')}</p>
          <p className="mt-1 text-muted-foreground">
            <Trans t={t} i18nKey="agentHelp.linksBody" values={TOOL_NAMES} components={HELP_COMPONENTS} />
          </p>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            <li><Code>{`${origin}/session/<${t('agentHelp.linkSessionPlaceholder')}>?prompt=…`}</Code> {t('agentHelp.linkSession')}</li>
            <li><Code>{`${origin}/?project=<${t('agentHelp.linkProjectPlaceholder')}>&prompt=…`}</Code> {t('agentHelp.linkProject')}</li>
          </ul>
          <p className="mt-1 text-muted-foreground">
            {t('agentHelp.linksFooter')}
          </p>
        </div>
      </div>
    </SettingsCard>
  );
}

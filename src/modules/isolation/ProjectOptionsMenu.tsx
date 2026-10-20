import { useState } from 'react';
import { Copy, MoreHorizontal, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ActionMenu } from '@/shared/ui';
import type { Project } from '@/shared/types';
import CopyProjectDialog from '@/modules/isolation/CopyProjectDialog';
import IsolationSettingsDialog from '@/modules/isolation/IsolationSettingsDialog';

type ProjectOptionsMenuProps = {
  project: Project;
  /** Called with the new project once a copy has finished. */
  onCopied: (project: Project) => void;
  className?: string;
};

/** The ⋯ menu of a project row (admins only): copy the agent and, for an isolated one, its isolation settings. */
export default function ProjectOptionsMenu({ project, onCopied, className }: ProjectOptionsMenuProps) {
  const { t } = useTranslation('isolation');
  const [copyOpen, setCopyOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className={className} onClick={(event) => event.stopPropagation()}>
      <ActionMenu
        label={t('menu.options', { name: project.displayName })}
        ariaLabel={t('menu.options', { name: project.displayName })}
        icon={MoreHorizontal}
        iconOnly
        portal
        variant="ghost"
        size="icon"
        triggerClassName="h-7 w-7 text-muted-foreground opacity-70 hover:bg-muted hover:opacity-100"
        menuClassName="w-[240px] rounded-xl p-1.5 shadow-xl"
        items={[
          { key: 'copy', label: t('menu.copy'), icon: Copy, onSelect: () => setCopyOpen(true) },
          ...(project.isolated === true
            ? [{ key: 'isolation', label: t('menu.settings'), icon: ShieldCheck, onSelect: () => setSettingsOpen(true) }]
            : []),
        ]}
      />
      {copyOpen && (
        <CopyProjectDialog project={project} open onOpenChange={setCopyOpen} onCopied={onCopied} />
      )}
      {settingsOpen && (
        <IsolationSettingsDialog project={project} open onOpenChange={setSettingsOpen} />
      )}
    </div>
  );
}

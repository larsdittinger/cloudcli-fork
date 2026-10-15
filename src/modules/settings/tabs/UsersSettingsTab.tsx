import { useState } from 'react';
import { KeyRound, Plus, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge, Button, Input } from '@/shared/ui';
import { useUsersSettings } from '@/modules/settings/hooks/useUsersSettings';
import type { AdminUser } from '@/modules/settings/hooks/useUsersSettings';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';

type UserRowProps = {
  user: AdminUser;
  projects: Array<{ projectId: string; displayName: string }>;
  onDelete: (userId: number) => Promise<string | null>;
  onSetPassword: (userId: number, password: string) => Promise<string | null>;
  onSetProjects: (userId: number, projectIds: string[]) => Promise<string | null>;
  onSetSeesAllSessions: (userId: number, enabled: boolean) => Promise<string | null>;
  onStopSharing: (userId: number, sessionId: string) => Promise<string | null>;
};

function UserRow({
  user,
  projects,
  onDelete,
  onSetPassword,
  onSetProjects,
  onSetSeesAllSessions,
  onStopSharing,
}: UserRowProps) {
  const { t } = useTranslation('settings');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showPasswordInput, setShowPasswordInput] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [rowError, setRowError] = useState<string | null>(null);
  const [rowNotice, setRowNotice] = useState<string | null>(null);

  const isRestricted = user.role === 'restricted';

  const handleToggleProject = async (projectId: string, granted: boolean) => {
    setRowError(null);
    const nextProjectIds = granted
      ? [...user.projectIds, projectId]
      : user.projectIds.filter((id) => id !== projectId);
    const errorMessage = await onSetProjects(user.id, nextProjectIds);
    if (errorMessage) setRowError(errorMessage);
  };

  const handlePasswordSave = async () => {
    setRowError(null);
    setRowNotice(null);
    const errorMessage = await onSetPassword(user.id, newPassword);
    if (errorMessage) {
      setRowError(errorMessage);
      return;
    }
    setNewPassword('');
    setShowPasswordInput(false);
    setRowNotice(t('users.passwordChanged', 'Password changed'));
  };

  const handleDelete = async () => {
    setRowError(null);
    const errorMessage = await onDelete(user.id);
    if (errorMessage) setRowError(errorMessage);
  };

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-foreground">{user.username}</span>
        <Badge variant={isRestricted ? 'secondary' : 'default'}>
          {isRestricted
            ? t('users.roleRestricted', 'Restricted')
            : t('users.roleAdmin', 'Admin')}
        </Badge>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-muted-foreground"
            onClick={() => {
              setShowPasswordInput((value) => !value);
              setRowNotice(null);
            }}
            title={t('users.changePassword', 'Change password')}
          >
            <KeyRound className="h-3.5 w-3.5" />
          </Button>
          {isRestricted && (
            confirmingDelete ? (
              <div className="flex items-center gap-1.5">
                <Button variant="destructive" size="sm" className="h-7 px-2" onClick={handleDelete}>
                  {t('users.confirmDelete', 'Confirm delete')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  onClick={() => setConfirmingDelete(false)}
                >
                  {t('users.cancel', 'Cancel')}
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-red-500 hover:text-red-600"
                onClick={() => setConfirmingDelete(true)}
                title={t('users.deleteUser', 'Delete user')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )
          )}
        </div>
      </div>

      {showPasswordInput && (
        <div className="flex items-center gap-2">
          <Input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            placeholder={t('users.newPasswordPlaceholder', 'New password (min 6 characters)')}
            className="h-8 max-w-xs"
          />
          <Button size="sm" className="h-8" onClick={handlePasswordSave} disabled={newPassword.length < 6}>
            {t('users.save', 'Save')}
          </Button>
        </div>
      )}

      {isRestricted && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">
            {t('users.allowedProjects', 'Allowed projects')}
          </p>
          {projects.length === 0 ? (
            <p className="text-xs text-muted-foreground/70">
              {t('users.noProjects', 'No projects available yet.')}
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {projects.map((project) => {
                const granted = user.projectIds.includes(project.projectId);
                return (
                  <label
                    key={project.projectId}
                    className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
                  >
                    <input
                      type="checkbox"
                      checked={granted}
                      onChange={(event) => void handleToggleProject(project.projectId, event.target.checked)}
                      className="h-3.5 w-3.5 rounded border-border"
                    />
                    <span className="truncate">{project.displayName}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}

      {isRestricted && (
        <div className="space-y-1.5">
          <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={Boolean(user.seesAllSessions)}
              onChange={async (event) => {
                setRowError(null);
                const errorMessage = await onSetSeesAllSessions(user.id, event.target.checked);
                if (errorMessage) setRowError(errorMessage);
              }}
              className="mt-0.5 h-3.5 w-3.5 rounded border-border"
            />
            <span>
              {t('users.seesAllSessions', 'Sees all chats in allowed projects')}
              <span className="block text-xs text-muted-foreground">
                {t(
                  'users.seesAllSessionsHint',
                  'Read only, including your chats and the ones agents start (Channels, Schedules, Tasks). They still write only into their own chats.',
                )}
              </span>
            </span>
          </label>

          {(user.sharedSessions?.length ?? 0) > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {t('users.sharedSessions', 'Chats shared with this user (read only)')}
              </p>
              <div className="flex flex-col gap-0.5">
                {user.sharedSessions!.map((shared) => (
                  <div key={shared.sessionId} className="flex items-center gap-2 text-sm text-foreground">
                    <span className="min-w-0 flex-1 truncate" title={shared.projectPath ?? undefined}>
                      {shared.title || shared.sessionId}
                      {shared.projectPath && (
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {shared.projectPath.split('/').filter(Boolean).pop()}
                        </span>
                      )}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-muted-foreground"
                      title={t('users.stopSharing', 'Stop sharing')}
                      onClick={async () => {
                        setRowError(null);
                        const errorMessage = await onStopSharing(user.id, shared.sessionId);
                        if (errorMessage) setRowError(errorMessage);
                      }}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {rowError && <p className="text-xs text-red-500">{rowError}</p>}
      {rowNotice && <p className="text-xs text-emerald-500">{rowNotice}</p>}
    </div>
  );
}

export default function UsersSettingsTab() {
  const { t } = useTranslation('settings');
  const {
    users,
    projects,
    isLoading,
    error,
    createUser,
    deleteUser,
    setUserPassword,
    setUserProjects,
    setUserSeesAllSessions,
    stopSharingSession,
  } = useUsersSettings();

  const [newUsername, setNewUsername] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const canCreate = newUsername.trim().length >= 3 && newUserPassword.length >= 6;

  const handleCreate = async () => {
    setCreateError(null);
    setIsCreating(true);
    try {
      const errorMessage = await createUser(newUsername.trim(), newUserPassword);
      if (errorMessage) {
        setCreateError(errorMessage);
        return;
      }
      setNewUsername('');
      setNewUserPassword('');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="space-y-8">
      <SettingsSection
        title={t('users.title', 'Users')}
        description={t(
          'users.description',
          'Manage accounts. Restricted users only see the projects you assign to them and can only use the chat. To show them one of your chats, use “Share with users…” in the chat’s menu.'
        )}
      >
        <SettingsCard divided>
          {isLoading && (
            <p className="p-4 text-sm text-muted-foreground">
              {t('users.loading', 'Loading users…')}
            </p>
          )}
          {!isLoading && error && <p className="p-4 text-sm text-red-500">{error}</p>}
          {!isLoading && !error && users.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              projects={projects}
              onDelete={deleteUser}
              onSetPassword={setUserPassword}
              onSetProjects={setUserProjects}
              onSetSeesAllSessions={setUserSeesAllSessions}
              onStopSharing={stopSharingSession}
            />
          ))}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('users.addTitle', 'Add restricted user')}
        description={t(
          'users.addDescription',
          'The new account can log in, but only sees its assigned projects and chat.'
        )}
      >
        <SettingsCard className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={newUsername}
              onChange={(event) => setNewUsername(event.target.value)}
              placeholder={t('users.usernamePlaceholder', 'Username (min 3 characters)')}
              className="h-8 max-w-xs"
            />
            <Input
              type="password"
              value={newUserPassword}
              onChange={(event) => setNewUserPassword(event.target.value)}
              placeholder={t('users.passwordPlaceholder', 'Password (min 6 characters)')}
              className="h-8 max-w-xs"
            />
            <Button size="sm" className="h-8" onClick={handleCreate} disabled={!canCreate || isCreating}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {isCreating ? t('users.creating', 'Creating…') : t('users.create', 'Create user')}
            </Button>
          </div>
          {createError && <p className="text-xs text-red-500">{createError}</p>}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

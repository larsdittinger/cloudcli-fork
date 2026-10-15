import { useEffect, useState } from 'react';
import { Eye, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';

type ShareableUser = { id: number; username: string };

type ShareSessionDialogProps = {
  sessionId: string;
  sessionName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Lets an admin pick the restricted users a chat is shared with. They can read
 * it (history and the live run), never write into it. Used by the session row
 * options in the Projects and Conversations lists, desktop and mobile.
 */
export default function ShareSessionDialog({ sessionId, sessionName, open, onOpenChange }: ShareSessionDialogProps) {
  const { t } = useTranslation('sidebar');
  const [users, setUsers] = useState<ShareableUser[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    void (async () => {
      try {
        const [usersResponse, sharesResponse] = await Promise.all([
          api.admin.listUsers(),
          api.admin.getSessionShares(sessionId),
        ]);
        if (!usersResponse.ok || !sharesResponse.ok) {
          throw new Error('load failed');
        }
        const usersPayload = (await usersResponse.json()) as { users?: Array<ShareableUser & { role: string }> };
        const sharesPayload = (await sharesResponse.json()) as { userIds?: number[] };
        if (cancelled) return;
        setUsers((usersPayload.users ?? []).filter((user) => user.role === 'restricted'));
        setSelected(new Set(sharesPayload.userIds ?? []));
      } catch {
        if (!cancelled) setError(t('share.loadError', 'Could not load users.'));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, t]);

  const toggleUser = (userId: number, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(userId); else next.delete(userId);
      return next;
    });
  };

  const save = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const response = await api.admin.setSessionShares(sessionId, [...selected]);
      if (!response.ok) {
        throw new Error('save failed');
      }
      onOpenChange(false);
    } catch {
      setError(t('share.saveError', 'Could not save sharing.'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(100vw-2rem,28rem)] max-w-none p-4">
        <DialogTitle>{t('share.title', 'Share chat')}</DialogTitle>
        {/* DialogTitle is screen-reader only, so the heading is drawn separately. */}
        <p aria-hidden className="text-base font-semibold text-foreground">{t('share.title', 'Share chat')}</p>
        <p className="mt-1 truncate text-sm text-muted-foreground" title={sessionName}>{sessionName}</p>
        <p className="mt-3 flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
          <Eye className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          {t(
            'share.explanation',
            'They can read this chat and watch it live, even without access to its project. They cannot write into it, stop it or open the project files.',
          )}
        </p>

        <div className="mt-3 max-h-64 space-y-1 overflow-y-auto">
          {isLoading ? (
            <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {t('share.loading', 'Loading…')}
            </p>
          ) : users.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              {t('share.noUsers', 'No restricted users yet. Create one in Settings → Users.')}
            </p>
          ) : (
            users.map((user) => (
              <label key={user.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-sm hover:bg-muted/50">
                <input
                  type="checkbox"
                  checked={selected.has(user.id)}
                  onChange={(event) => toggleUser(user.id, event.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                <span className="truncate">{user.username}</span>
              </label>
            ))
          )}
        </div>

        {error && <p className="mt-2 text-xs text-red-500">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('share.cancel', 'Cancel')}
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={isLoading || isSaving}>
            {isSaving ? t('share.saving', 'Saving…') : t('share.save', 'Save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

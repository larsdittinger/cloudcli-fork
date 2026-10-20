import { useEffect, useState } from 'react';
import { Check, Loader2, ShieldCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle, Switch } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { Project } from '@/shared/types';
import {
  allowlistLineFor,
  errorMessage,
  useIsolationStatus,
  type BlockedEntry,
  type IsolationTools,
  type LineError,
  type SelfCheck,
} from '@/modules/isolation/hooks/useIsolation';

type IsolationSettingsDialogProps = {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const FIELD = 'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30';

/** Network allowlist, app tools, blocked requests and the isolation self-check of one isolated project. */
export default function IsolationSettingsDialog({ project, open, onOpenChange }: IsolationSettingsDialogProps) {
  const { t, i18n } = useTranslation('isolation');
  const status = useIsolationStatus(open);
  const [allowlist, setAllowlist] = useState('');
  const [tools, setTools] = useState<IsolationTools>({ channels: true, tasks: true });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [lineErrors, setLineErrors] = useState<LineError[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [blocked, setBlocked] = useState<BlockedEntry[]>([]);
  const [blockedError, setBlockedError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checks, setChecks] = useState<SelfCheck[] | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded(false);
    setLoadError(false);
    void api.isolation.project(project.projectId)
      .then((response) => readApiJson<{ data: { allowlist: string[]; tools: IsolationTools } }>(response))
      .then((body) => {
        if (cancelled) return;
        setAllowlist(body.data.allowlist.join('\n'));
        setTools(body.data.tools);
        setLoaded(true);
      })
      .catch(() => { if (!cancelled) setLoadError(true); });
    setBlockedError(null);
    void api.isolation.blocked(project.projectId)
      .then((response) => readApiJson<{ data: BlockedEntry[] }>(response))
      .then((body) => { if (!cancelled) setBlocked([...body.data].reverse()); })
      .catch((error: unknown) => { if (!cancelled) setBlockedError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [open, project.projectId]);

  const lines = allowlist.split(/\r?\n/).map((line) => line.trim());

  const allow = (entry: BlockedEntry) => {
    const line = allowlistLineFor(entry);
    if (!line) return;
    setAllowlist((current) => {
      if (current.split(/\r?\n/).some((existing) => existing.trim() === line)) return current;
      return current.trim() ? `${current.replace(/\s+$/, '')}\n${line}` : line;
    });
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    setLineErrors([]);
    try {
      const response = await api.isolation.saveProject(project.projectId, { allowlist: allowlist.split(/\r?\n/), tools });
      const body = await response.json() as { success?: boolean; errors?: LineError[]; error?: { message?: string } | string; data?: { daemonSync?: { ok: boolean; error?: string } } };
      if (!response.ok || body.success === false) {
        if (Array.isArray(body.errors) && body.errors.length) {
          setLineErrors(body.errors);
          return;
        }
        const reason = typeof body.error === 'string' ? body.error : body.error?.message ?? `HTTP ${response.status}`;
        throw new Error(reason);
      }
      const sync = body.data?.daemonSync;
      setMessage(sync && !sync.ok
        ? { kind: 'error', text: t('settings.syncFailed', { message: sync.error ?? '' }) }
        : { kind: 'ok', text: t('settings.saved') });
    } catch (error) {
      setMessage({ kind: 'error', text: t('settings.saveError', { message: errorMessage(error) }) });
    } finally {
      setSaving(false);
    }
  };

  const runCheck = async () => {
    setChecking(true);
    setCheckError(null);
    setChecks(null);
    try {
      const body = await readApiJson<{ data: { checks: SelfCheck[] } }>(await api.isolation.selfCheck(project.projectId));
      setChecks(body.data.checks);
    } catch (error) {
      setCheckError(t('settings.checkError', { message: errorMessage(error) }));
    } finally {
      setChecking(false);
    }
  };

  const sandboxLine = !status
    ? null
    : !status.available
      ? { ok: false, text: t('settings.sandboxUnavailable', { reason: status.reason ?? '' }) }
      : status.daemon?.running && status.daemon.ok
        ? { ok: true, text: t('settings.sandboxRunning', { projects: status.daemon.projects ?? 0 }) }
        : { ok: false, text: t('settings.sandboxDown', { reason: status.daemon?.reason ?? '' }) };

  const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wrapperClassName="z-[10000]" className="max-h-[92vh] w-[min(100vw-1rem,40rem)] max-w-none overflow-y-auto p-4">
        <DialogTitle className="flex items-center gap-2 text-base font-semibold">
          <ShieldCheck className="h-4 w-4 text-red-600 dark:text-red-400" aria-hidden />
          {t('settings.title', { name: project.displayName })}
        </DialogTitle>

        {sandboxLine && (
          <p className={cn('mt-2 text-xs', sandboxLine.ok ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-300')}>
            <span className="font-medium">{t('settings.sandbox')}: </span>{sandboxLine.text}
          </p>
        )}

        {loadError ? (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">{t('settings.loadError')}</p>
        ) : !loaded ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('settings.loading')}</p>
        ) : (
          <div className="mt-3 space-y-5">
            <div className="space-y-1">
              <label htmlFor="isolation-allowlist" className="text-sm font-medium">{t('settings.allowlist')}</label>
              <textarea
                id="isolation-allowlist"
                className={cn(FIELD, 'min-h-[120px] font-mono text-xs', lineErrors.length > 0 && 'border-red-500')}
                value={allowlist}
                spellCheck={false}
                onChange={(event) => { setAllowlist(event.target.value); setLineErrors([]); }}
              />
              <p className="text-xs text-muted-foreground">{t('settings.allowlistHint')}</p>
              {lineErrors.length > 0 && (
                <ul role="alert" className="space-y-0.5 text-xs text-red-600 dark:text-red-400">
                  {lineErrors.map((error) => (
                    <li key={`${error.line}-${error.message}`}>
                      {t('settings.lineError', { line: error.line, message: error.message })}
                      {lines[error.line - 1] ? <code className="ml-1 opacity-70">{lines[error.line - 1]}</code> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-medium">{t('settings.tools')}</h3>
              {([
                ['channels', t('settings.toolChannels'), t('settings.toolChannelsHint')],
                ['tasks', t('settings.toolTasks'), t('settings.toolTasksHint')],
              ] as const).map(([key, label, hint]) => (
                <div key={key} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm">{label}</p>
                    <p className="text-xs text-muted-foreground">{hint}</p>
                  </div>
                  <Switch label={label} checked={tools[key]} onChange={(value) => setTools((current) => ({ ...current, [key]: value }))} />
                </div>
              ))}
            </div>

            <div className="flex items-center gap-3">
              <Button size="sm" onClick={() => void save()} disabled={saving}>{saving ? t('settings.saving') : t('settings.save')}</Button>
              {message && (
                <span role="status" className={cn('text-xs', message.kind === 'ok' ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400')}>{message.text}</span>
              )}
            </div>
          </div>
        )}

        <div className="mt-5 space-y-2 border-t border-border pt-4">
          <h3 className="text-sm font-medium">{t('settings.blocked')}</h3>
          {blockedError ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">{t('settings.blockedError', { message: blockedError })}</p>
          ) : blocked.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('settings.blockedEmpty')}</p>
          ) : (
            <ul className="max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border text-sm">
              {blocked.map((entry, index) => {
                const line = allowlistLineFor(entry);
                const already = line !== null && lines.includes(line);
                return (
                  <li key={`${index}-${entry.at}-${entry.host}-${entry.port}`} className="flex items-center justify-between gap-2 px-2 py-1.5">
                    <span className="min-w-0 truncate">
                      <time className="mr-2 text-xs tabular-nums text-muted-foreground" dateTime={entry.at}>{timeOf(entry.at)}</time>
                      <span className="font-mono text-xs">{entry.host}:{entry.port}</span>
                    </span>
                    <Button variant="outline" size="sm" disabled={already || line === null} onClick={() => allow(entry)}>
                      {already ? t('settings.allowed') : t('settings.allow')}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="mt-5 space-y-2 border-t border-border pt-4">
          <Button variant="outline" size="sm" onClick={() => void runCheck()} disabled={checking}>
            {checking ? t('settings.checking') : t('settings.check')}
          </Button>
          {checkError && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{checkError}</p>}
          {checks && (
            <table className="w-full table-fixed text-left text-xs" aria-label={t('settings.checkTitle')}>
              <tbody>
                {checks.map((check) => (
                  <tr key={check.id} className="border-t border-border first:border-t-0 align-top">
                    <td className="w-6 py-1">
                      {check.ok
                        ? <Check className="h-4 w-4 text-green-600 dark:text-green-400" aria-label={t('settings.checkOk')} />
                        : <X className="h-4 w-4 text-red-600 dark:text-red-400" aria-label={t('settings.checkFail')} />}
                    </td>
                    <td className="break-words py-1 pr-2 font-mono">{check.id}</td>
                    <td className="break-all py-1 text-muted-foreground">{check.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="mt-5 flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{t('settings.close')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

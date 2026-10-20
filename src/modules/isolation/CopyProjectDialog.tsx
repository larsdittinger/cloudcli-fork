import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '@/shared/ui';
import type { Project } from '@/shared/types';
import { errorMessage, formatBytes, useIsolationStatus } from '@/modules/isolation/hooks/useIsolation';

type CopyPreview = {
  suggestedName: string;
  sizeBytes: number;
  fileCount: number;
  secretFiles: string[];
  userScopeMcp: Array<{ name: string; hasSecrets: boolean }>;
  isolationAvailable: boolean;
};

type CopyProgress = {
  copiedBytes: number;
  totalBytes: number;
  done: boolean;
  error?: string;
  project?: Project;
  warnings: string[];
};

type CopyProjectDialogProps = {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The finished copy; the caller selects it. */
  onCopied: (project: Project) => void;
};

const POLL_MS = 700;

/** Defaults follow the isolation choice: an isolated copy leaves secrets and keyed MCP servers behind. */
function defaultsFor(preview: CopyPreview, isolated: boolean) {
  return {
    exclude: new Set(isolated ? preview.secretFiles : []),
    carry: new Set(preview.userScopeMcp.filter((server) => !(isolated && server.hasSecrets)).map((server) => server.name)),
  };
}

/** Copy of an agent (its project directory), optionally as an isolated project, with progress and cancel. */
export default function CopyProjectDialog({ project, open, onOpenChange, onCopied }: CopyProjectDialogProps) {
  const { t } = useTranslation('isolation');
  const status = useIsolationStatus(open);
  const [preview, setPreview] = useState<CopyPreview | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState('');
  const [isolated, setIsolated] = useState(false);
  const [exclude, setExclude] = useState<Set<string>>(new Set());
  const [carry, setCarry] = useState<Set<string>>(new Set());
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<CopyProgress | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadError(false);
    void api.copyProject.preview(project.projectId)
      .then((response) => readApiJson<CopyPreview>(response))
      .then((data) => {
        if (cancelled) return;
        setPreview(data);
        setName(data.suggestedName);
        const defaults = defaultsFor(data, false);
        setExclude(defaults.exclude);
        setCarry(defaults.carry);
      })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [open, project.projectId]);

  const isolationAvailable = Boolean(preview?.isolationAvailable) && status?.available !== false;
  const running = jobId !== null && !(progress?.done);

  const changeIsolated = (next: boolean) => {
    setIsolated(next);
    if (!preview) return;
    const defaults = defaultsFor(preview, next);
    setExclude(defaults.exclude);
    setCarry(defaults.carry);
  };

  const toggle = (setter: typeof setExclude, value: string, on: boolean) =>
    setter((previous) => {
      const next = new Set(previous);
      if (on) next.add(value); else next.delete(value);
      return next;
    });

  const poll = useCallback(async (id: string) => {
    while (alive.current) {
      let current: CopyProgress;
      try {
        current = await readApiJson<CopyProgress>(await api.copyProject.progress(id));
      } catch (pollError) {
        if (alive.current) { setError(t('copy.failed', { message: errorMessage(pollError) })); setJobId(null); }
        return;
      }
      if (!alive.current) return;
      setProgress(current);
      if (current.done) {
        if (current.error) {
          setError(t('copy.failed', { message: current.error }));
          setJobId(null);
        } else if (current.project) {
          onCopied(current.project);
          if (!current.warnings?.length) onOpenChange(false);
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }, [onCopied, onOpenChange, t]);

  const start = async () => {
    if (!preview) return;
    setStarting(true);
    setError(null);
    setProgress(null);
    try {
      const body = await readApiJson<{ jobId: string }>(await api.copyProject.start(project.projectId, {
        name: name.trim(),
        isolated,
        excludeSecretFiles: [...exclude],
        carryMcp: [...carry],
      }));
      setJobId(body.jobId);
      void poll(body.jobId);
    } catch (startError) {
      setError(t('copy.failed', { message: errorMessage(startError) }));
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!jobId) return;
    setCancelling(true);
    try {
      await api.copyProject.cancel(jobId);
    } catch (cancelError) {
      setError(t('copy.failed', { message: errorMessage(cancelError) }));
    } finally {
      setCancelling(false);
    }
  };

  const finished = Boolean(progress?.done && !progress.error);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!running) onOpenChange(next); }}>
      <DialogContent wrapperClassName="z-[10000]" className="max-h-[92vh] w-[min(100vw-1rem,34rem)] max-w-none overflow-y-auto p-4">
        <DialogTitle className="text-base font-semibold">{t('copy.title')}</DialogTitle>
        <p className="mt-1 truncate text-sm text-muted-foreground" title={project.fullPath}>{t('copy.source', { name: project.displayName })}</p>

        {loadError ? (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">{t('copy.loadError')}</p>
        ) : !preview ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('copy.loading')}</p>
        ) : (
          <div className="mt-3 space-y-4">
            <div className="space-y-1">
              <label htmlFor="copy-name" className="text-sm font-medium">{t('copy.name')}</label>
              <Input id="copy-name" value={name} onChange={(event) => setName(event.target.value)} disabled={running || finished} />
              <p className="text-xs text-muted-foreground">{t('copy.nameHint')}</p>
              <p className="text-xs text-muted-foreground">{t('copy.summary', { files: preview.fileCount, size: formatBytes(preview.sizeBytes) })}</p>
            </div>

            <div className="space-y-1">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={isolated}
                  disabled={!isolationAvailable || running || finished}
                  onChange={(event) => changeIsolated(event.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                <Lock className="h-3.5 w-3.5 text-red-600 dark:text-red-400" aria-hidden />
                {t('copy.isolated')}
              </label>
              <p className="text-xs text-muted-foreground">{isolationAvailable ? t('copy.isolatedHint') : t('copy.isolatedUnavailable')}</p>
            </div>

            <fieldset className="space-y-1" disabled={running || finished}>
              <legend className="text-sm font-medium">{t('copy.secretFiles')}</legend>
              {preview.secretFiles.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('copy.noSecretFiles')}</p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">{t('copy.secretFilesHint')}</p>
                  {preview.secretFiles.map((file) => (
                    <label key={file} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={exclude.has(file)} onChange={(event) => toggle(setExclude, file, event.target.checked)} className="h-4 w-4 rounded border-border" />
                      <span className="truncate font-mono text-xs">{file}</span>
                    </label>
                  ))}
                </>
              )}
            </fieldset>

            <fieldset className="space-y-1" disabled={running || finished}>
              <legend className="text-sm font-medium">{t('copy.mcp')}</legend>
              {preview.userScopeMcp.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('copy.noMcp')}</p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">{t('copy.mcpHint')}</p>
                  {isolated && preview.userScopeMcp.some((server) => server.hasSecrets) && (
                    <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200">{t('copy.mcpIsolatedWarning')}</p>
                  )}
                  {preview.userScopeMcp.map((server) => (
                    <label key={server.name} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={carry.has(server.name)} onChange={(event) => toggle(setCarry, server.name, event.target.checked)} className="h-4 w-4 rounded border-border" />
                      <span>{server.name}</span>
                      {server.hasSecrets && <span className="text-xs text-amber-700 dark:text-amber-300">({t('copy.mcpSecrets')})</span>}
                    </label>
                  ))}
                </>
              )}
            </fieldset>

            {(running || progress) && (
              <div role="status" className="space-y-1 text-sm">
                {finished ? (
                  <p>{t('copy.done')}</p>
                ) : (
                  <p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />
                    {cancelling
                      ? t('copy.cancelling')
                      : progress && progress.totalBytes > 0
                        ? t('copy.progress', { copied: formatBytes(progress.copiedBytes), total: formatBytes(progress.totalBytes) })
                        : t('copy.progressUnknown', { copied: formatBytes(progress?.copiedBytes ?? 0) })}
                  </p>
                )}
                {progress && progress.totalBytes > 0 && (
                  <div className="h-1.5 overflow-hidden rounded bg-muted">
                    <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, Math.round((progress.copiedBytes / progress.totalBytes) * 100))}%` }} />
                  </div>
                )}
                {progress?.warnings?.length ? (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200">
                    <p className="font-medium">{t('copy.warnings')}</p>
                    <ul className="list-disc pl-4">{progress.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}

        {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          {running ? (
            <Button variant="outline" size="sm" onClick={() => void cancel()} disabled={cancelling}>{t('copy.stop')}</Button>
          ) : finished ? (
            <Button size="sm" onClick={() => onOpenChange(false)}>{t('copy.close')}</Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{t('copy.cancel')}</Button>
              <Button size="sm" onClick={() => void start()} disabled={!preview || starting || !name.trim()}>{t('copy.start')}</Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

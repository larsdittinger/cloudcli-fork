import { useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { needsClaudeLogin, useClaudeLogin, useIsolationStatusResult } from '@/modules/isolation';
import type { ClaudeLoginState } from '@/modules/isolation';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';
import { api, ApiRequestError, readApiJson } from '@/shared/api';
import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';

const FIELD = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30';
// Error codes of PUT /api/isolation/claude-login that have their own text; others show the server's message.
const LOCALIZED_ERRORS = new Set(['NO_TOKEN', 'MULTIPLE_TOKENS', 'TOKEN_TOO_SHORT', 'TOKEN_REJECTED', 'VERIFY_UNAVAILABLE']);

/** A commit (the sandbox image is tagged with the fork's commit) shortened like git does; anything else as is. */
const shortVersion = (version: string) => (/^[0-9a-f]{12,}$/i.test(version) ? version.slice(0, 7) : version);

/** Texts mark commands with `backticks`: shown as code. */
function withCode(text: string): ReactNode {
  return text.split('`').map((part, index) => (index % 2 === 1 ? <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{part}</code> : part));
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="min-w-0 break-words text-sm text-foreground sm:text-right">{children}</div>
    </div>
  );
}

/** Rendered by Settings for the "isolation" tab (admins): sandbox state and the Claude login of isolated agents. */
export default function IsolationSettingsTab() {
  const { t, i18n } = useTranslation('isolation');
  const { status, error: statusError } = useIsolationStatusResult(true);
  const { state: login, setState: setLogin, loadError } = useClaudeLogin(true);
  // The pasted `claude setup-token` output; emptied once saved so the token does not stay in the page.
  const [pasted, setPasted] = useState('');
  // Which request is in flight: disables the buttons and labels the busy one.
  const [busy, setBusy] = useState<'save' | 'check' | 'remove' | null>(null);
  // Outcome of the last save/check/remove; `canForce` offers saving unverified when Anthropic did not answer.
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string; canForce?: boolean } | null>(null);
  // "Remove token" was clicked once and waits for the confirmation.
  const [confirmRemove, setConfirmRemove] = useState(false);

  const formatDate = (iso: string) => new Date(iso).toLocaleString(i18n.language, {
    day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const errorText = (error: unknown): string => {
    if (error instanceof ApiRequestError && error.code && LOCALIZED_ERRORS.has(error.code)) {
      const details = (error.details && typeof error.details === 'object' ? error.details : {}) as { status?: number | null; message?: string };
      // 403 on the verification call need not be the token (scope of count_tokens): its own warning.
      const key = error.code === 'VERIFY_UNAVAILABLE' && details.status === 403 ? 'VERIFY_FORBIDDEN' : error.code;
      return t(`login.errors.${key}`, { status: details.status ?? '—', message: details.message ?? error.message });
    }
    return error instanceof Error ? error.message : String(error);
  };

  const run = async (kind: 'save' | 'check' | 'remove', request: () => Promise<Response>, onDone?: (state: ClaudeLoginState) => void) => {
    setBusy(kind);
    setMessage(null);
    try {
      const body = await readApiJson<{ data: ClaudeLoginState }>(await request());
      setLogin(body.data);
      onDone?.(body.data);
    } catch (error) {
      // A token Anthropic refused is of no further use: it does not stay in the page either.
      if (error instanceof ApiRequestError && error.code === 'TOKEN_REJECTED') setPasted('');
      setMessage({ kind: 'error', text: errorText(error), canForce: error instanceof ApiRequestError && error.code === 'VERIFY_UNAVAILABLE' });
    } finally {
      setBusy(null);
    }
  };

  const save = (force: boolean) => run('save', () => api.isolation.saveClaudeLogin({ text: pasted, force }), (state) => {
    setPasted('');
    setMessage({ kind: 'ok', text: state.lastCheck?.ok ? t('login.saved') : t('login.savedUnverified') });
  });

  const remove = () => run('remove', () => api.isolation.removeClaudeLogin(), () => setConfirmRemove(false));

  if (status && !status.available) {
    return (
      <div className="space-y-8">
        <SettingsSection title={t('tab.sandboxTitle')}>
          <SettingsCard className="p-4">
            <p className="text-sm text-foreground">{t('tab.unavailable')}</p>
            {status.reason && <p className="mt-1 break-words font-mono text-xs text-muted-foreground">{status.reason}</p>}
          </SettingsCard>
        </SettingsSection>
      </div>
    );
  }

  if (!status) {
    // The login form waits for the status: on an instance without isolation it has nothing to configure.
    return (
      <div className="space-y-8">
        <SettingsSection title={t('tab.sandboxTitle')}>
          <SettingsCard className="p-4">
            {statusError ? (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t('tab.statusError', { message: statusError })}</p>
            ) : (
              <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('settings.loading')}</p>
            )}
          </SettingsCard>
        </SettingsSection>
      </div>
    );
  }

  const daemon = status.daemon;
  const daemonState = !daemon
    ? null
    : daemon.running && daemon.ok
      ? { ok: true, text: t('tab.running') }
      : { ok: false, text: daemon.running ? t('tab.notReady') : t('tab.notRunning') };

  return (
    <div className="space-y-8">
      <SettingsSection title={t('tab.sandboxTitle')} description={t('tab.sandboxDescription')}>
        <SettingsCard divided>
          <InfoRow label={t('tab.state')}>
            {daemonState && (
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className={cn('h-2 w-2 rounded-full', daemonState.ok ? 'bg-green-500' : 'bg-red-500')} />
                <span className={cn('font-medium', daemonState.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400')}>{daemonState.text}</span>
              </span>
            )}
            {daemon?.reason && <span className="mt-0.5 block break-words text-xs text-muted-foreground">{daemon.reason}</span>}
          </InfoRow>
          <InfoRow label={t('tab.daemonVersion')}>
            {daemon?.version ? <code className="font-mono text-xs" title={daemon.version}>{shortVersion(daemon.version)}</code> : <span className="text-muted-foreground">{t('tab.unknown')}</span>}
          </InfoRow>
          <InfoRow label={t('tab.claudeVersion')}>
            {daemon?.claudeVersion ? <span>{daemon.claudeVersion}</span> : <span className="text-muted-foreground">{t('tab.unknown')}</span>}
          </InfoRow>
          <InfoRow label={t('tab.isolatedProjects')}>
            <span className="tabular-nums">{status.isolatedProjects ?? 0}</span>
          </InfoRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('login.title')} description={t('login.description')}>
        {loadError && !login ? (
          <SettingsCard className="p-4"><p className="text-sm text-red-600 dark:text-red-400">{t('login.loadError', { message: loadError })}</p></SettingsCard>
        ) : !login ? (
          <SettingsCard className="p-4">
            <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('settings.loading')}</p>
          </SettingsCard>
        ) : (
          <SettingsCard divided>
            <LoginSummary login={login} formatDate={formatDate} />

            <InfoRow label={t('login.lastCheck')}>
              {!login.lastCheck ? (
                <span className="text-muted-foreground">{t('login.notChecked')}</span>
              ) : login.lastCheck.ok ? (
                <span className="text-green-700 dark:text-green-400">{t('login.resultOk', { date: formatDate(login.lastCheck.at) })}</span>
              ) : (
                <span className={login.lastCheck.unverified ? 'text-amber-700 dark:text-amber-300' : 'text-red-600 dark:text-red-400'}>
                  {login.lastCheck.unverified
                    ? t('login.checkUnverified', { date: formatDate(login.lastCheck.at), message: login.lastCheck.error ?? '' })
                    : login.lastCheck.status
                      ? t('login.resultError', { status: login.lastCheck.status, date: formatDate(login.lastCheck.at), message: login.lastCheck.error ?? '' })
                      : t('login.resultErrorNoStatus', { date: formatDate(login.lastCheck.at), message: login.lastCheck.error ?? '' })}
                </span>
              )}
            </InfoRow>

            <InfoRow label={t('login.lastUpstream')}>
              {!login.lastUpstream.okAt && !login.lastUpstream.error && <span className="text-muted-foreground">{t('login.upstreamNone')}</span>}
              {login.lastUpstream.okAt && (
                <span className="block text-green-700 dark:text-green-400">{t('login.resultOk', { date: formatDate(login.lastUpstream.okAt) })}</span>
              )}
              {login.lastUpstream.error && (
                <span className="block text-red-600 dark:text-red-400">
                  {login.lastUpstream.error.status
                    ? t('login.resultError', { status: login.lastUpstream.error.status, date: formatDate(login.lastUpstream.error.at), message: login.lastUpstream.error.message })
                    : t('login.resultErrorNoStatus', { date: formatDate(login.lastUpstream.error.at), message: login.lastUpstream.error.message })}
                </span>
              )}
            </InfoRow>

            <div className="flex flex-wrap items-center gap-2 px-4 py-3">
              <Button variant="outline" size="sm" disabled={busy !== null || login.source === 'missing'} onClick={() => void run('check', () => api.isolation.checkClaudeLogin())}>
                {busy === 'check' ? t('login.checking') : t('login.check')}
              </Button>
              {login.tokenLast4 && !confirmRemove && (
                <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>{t('login.remove')}</Button>
              )}
              {confirmRemove && (
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{t('login.removeConfirm')}</span>
                  <Button variant="destructive" size="sm" disabled={busy !== null} onClick={() => void remove()}>
                    {busy === 'remove' ? t('login.removing') : t('login.removeYes')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmRemove(false)}>{t('login.cancel')}</Button>
                </span>
              )}
            </div>
          </SettingsCard>
        )}

        <SettingsCard className="space-y-3 p-4">
          <label htmlFor="isolation-setup-token" className="block text-sm font-medium text-foreground">
            {withCode(t('login.pasteLabel'))}
          </label>
          <textarea
            id="isolation-setup-token"
            className={cn(FIELD, 'min-h-[96px] font-mono text-xs')}
            value={pasted}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            onChange={(event) => { setPasted(event.target.value); setMessage(null); }}
          />
          <p className="text-xs text-muted-foreground">{t('login.pasteHint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy !== null || !pasted.trim()} onClick={() => void save(false)}>
              {busy === 'save' ? t('login.saving') : t('login.save')}
            </Button>
            {message?.canForce && (
              <Button variant="outline" size="sm" disabled={busy !== null || !pasted.trim()} onClick={() => void save(true)}>{t('login.saveForce')}</Button>
            )}
          </div>
          {message && (
            <p role={message.kind === 'error' ? 'alert' : 'status'} className={cn('break-words text-xs', message.kind === 'ok' ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400')}>
              {withCode(message.text)}
            </p>
          )}
        </SettingsCard>

        <SettingsCard className="p-4">
          <h4 className="text-sm font-medium text-foreground">{t('guide.title')}</h4>
          <ol className="mt-2 list-inside list-decimal space-y-1 text-sm text-muted-foreground">
            <li>{withCode(t('guide.step1'))}</li>
            <li>{withCode(t('guide.step2'))}</li>
            <li>{withCode(t('guide.step3'))}</li>
          </ol>
          <p className="mt-2 text-sm text-muted-foreground">{t('guide.note')}</p>
          <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            {t('guide.warning')}
          </p>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

/** ✅ / ⚠️ / ❌ of the login the proxy uses now. */
function LoginSummary({ login, formatDate }: { login: ClaudeLoginState; formatDate: (iso: string) => string }) {
  const { t } = useTranslation('isolation');

  if (login.source === 'setup-token') {
    // Anthropic refused this token (last check or the proxy's last request): no reason for a green tick.
    const refused = needsClaudeLogin(login);
    return (
      <div className="flex items-start gap-3 px-4 py-4">
        {refused
          ? <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
          : <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600 dark:text-green-400" aria-hidden />}
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{t('login.setupToken')}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t('login.tokenEnding', { last4: login.tokenLast4 ?? '' })}
            {' · '}
            {login.tokenSetAt ? t('login.savedAt', { date: formatDate(login.tokenSetAt) }) : t('login.savedFromHub')}
          </p>
          {refused && <p className="mt-1 text-sm font-medium text-red-600 dark:text-red-400">{t('login.upstreamAuth')}</p>}
        </div>
      </div>
    );
  }

  if (login.source === 'credentials') {
    return (
      <div className="flex items-start gap-3 px-4 py-4">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{t('login.credentials')}</p>
          {login.credentialsExpiresAt && (
            <p className="mt-0.5 text-sm text-muted-foreground">{t('login.credentialsExpires', { date: formatDate(login.credentialsExpiresAt) })}</p>
          )}
          <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">{t('login.credentialsWarning')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 px-4 py-4">
      <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{t('login.missing')}</p>
        {login.credentialsExpiresAt && (
          <p className="mt-0.5 text-sm text-muted-foreground">{t('login.credentialsExpired', { date: formatDate(login.credentialsExpiresAt) })}</p>
        )}
      </div>
    </div>
  );
}

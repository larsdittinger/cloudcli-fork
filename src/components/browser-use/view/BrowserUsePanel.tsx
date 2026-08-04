import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClipboardEvent as ReactClipboardEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  WheelEvent as ReactWheelEvent,
} from 'react';
import {
  Bot,
  Clock3,
  Download,
  Expand,
  ExternalLink,
  Loader2,
  MonitorPlay,
  RefreshCw,
  Settings,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';

import { cn } from '../../../lib/utils';
import { Badge, Button } from '../../../shared/view/ui';
import { authenticatedFetch } from '../../../utils/api';
import type { SettingsMainTab } from '../../settings/types/types';

type BrowserUseStatus = {
  enabled: boolean;
  available: boolean;
  playwrightInstalled: boolean;
  chromiumInstalled: boolean;
  installInProgress: boolean;
  sessionCount: number;
  message: string;
};

type BrowserUseSession = {
  id: string;
  status: 'ready' | 'stopped' | 'unavailable';
  url: string | null;
  title: string | null;
  screenshotDataUrl: string | null;
  createdAt: string;
  updatedAt: string;
  lastAction: string | null;
  message: string | null;
  createdBy: 'agent';
  profileName: string | null;
  viewport: {
    width: number;
    height: number;
  } | null;
  // ethia fork: device emulation currently applied to the session.
  emulation?: BrowserEmulation | null;
  cursor: {
    x: number;
    y: number;
    actor: 'agent';
  } | null;
};

// ethia fork: mobile emulation + DevTools for agent browser sessions.
type BrowserEmulation = {
  preset: string | null;
  label: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  landscape: boolean;
  userAgent: string | null;
};

type DevicePreset = {
  id: string;
  label: string;
  category: 'phone' | 'tablet' | 'desktop';
  width: number;
  height: number;
};

type ConsoleEntry = {
  id: number;
  type: string;
  text: string;
  location: string | null;
  timestamp: string;
};

type NetworkEntry = {
  id: number;
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  ok: boolean | null;
  failure: string | null;
  durationMs: number | null;
};

type DevtoolsPayload = {
  counts: {
    console: number;
    errors: number;
    warnings: number;
    requests: number;
    failedRequests: number;
  };
  console?: ConsoleEntry[];
  network?: NetworkEntry[];
};

type BrowserUsePanelProps = {
  isVisible: boolean;
  onShowSettings?: (tab?: SettingsMainTab) => void;
};

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || data.details || `Request failed (${response.status})`);
  }
  return data as T;
}

function formatRelativeTime(value: string | null): string {
  if (!value) return 'Never';

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Unknown';

  const elapsedSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 10) return 'Just now';
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;
  return `${Math.round(elapsedHours / 24)}d ago`;
}

function getDomain(url: string | null): string {
  if (!url) return 'No page loaded';

  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatAction(action: string | null): string {
  if (!action) return 'Waiting';
  return action.replace(/_/g, ' ').replace(/:/g, ': ');
}

function getStatusTone(status: BrowserUseSession['status']): string {
  if (status === 'ready') {
    return 'border-primary/30 bg-primary/5 text-foreground';
  }
  if (status === 'stopped') {
    return 'border-border bg-muted text-muted-foreground';
  }
  return 'border-border bg-background text-muted-foreground';
}

function getRuntimeTone(status: BrowserUseStatus | null, installing: boolean): string {
  if (!status?.enabled) return 'border-border bg-muted text-muted-foreground';
  if (status.available) return 'border-primary/30 bg-primary/5 text-foreground';
  if (status.installInProgress || installing) return 'border-primary/30 bg-primary/5 text-foreground';
  return 'border-border bg-background text-muted-foreground';
}

function getStatusDot(status: BrowserUseSession['status']): string {
  if (status === 'ready') return 'bg-primary';
  if (status === 'stopped') return 'bg-muted-foreground/50';
  return 'bg-border';
}

const PROMPTS = [
  'Use Browser to inspect the checkout flow and report any broken UI states.',
  // ethia fork: advertise the mobile + devtools tools agents now have.
  'Open <url> with Browser on device iphone-15, screenshot it, and report layout problems, console errors and failed requests.',
];

// ethia fork: keys forwarded into the live session from the interactive preview.
const INTERACTIVE_KEYS = new Set([
  'Enter',
  'Backspace',
  'Delete',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

export default function BrowserUsePanel({ isVisible, onShowSettings }: BrowserUsePanelProps) {
  const [status, setStatus] = useState<BrowserUseStatus | null>(null);
  const [sessions, setSessions] = useState<BrowserUseSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  // ethia fork: device emulation + DevTools drawer.
  const [devices, setDevices] = useState<DevicePreset[]>([]);
  const [devtools, setDevtools] = useState<DevtoolsPayload | null>(null);
  const [isDevtoolsOpen, setIsDevtoolsOpen] = useState(false);
  const [devtoolsTab, setDevtoolsTab] = useState<'console' | 'network'>('console');
  const inputQueueRef = useRef<Promise<void>>(Promise.resolve());
  const wheelDeltaRef = useRef(0);
  const wheelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) || sessions[0] || null,
    [selectedSessionId, sessions],
  );

  const activeSessions = sessions.filter((session) => session.status === 'ready');
  const needsBrowserBinaries = Boolean(status?.enabled && (!status.playwrightInstalled || !status.chromiumInstalled));
  const runtimeLabel = !status?.enabled
    ? 'Disabled'
    : status.available
      ? 'Ready'
      : status.installInProgress || isInstalling
        ? 'Installing'
        : 'Setup required';

  const cursorStyle = selectedSession?.cursor && selectedSession.viewport
    ? {
      left: `${(selectedSession.cursor.x / selectedSession.viewport.width) * 100}%`,
      top: `${(selectedSession.cursor.y / selectedSession.viewport.height) * 100}%`,
    }
    : null;

  const refresh = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) {
      setIsRefreshing(true);
    }
    try {
      const [statusResponse, sessionsResponse] = await Promise.all([
        authenticatedFetch('/api/browser-use/status'),
        authenticatedFetch('/api/browser-use/sessions'),
      ]);
      const statusData = await readJson<{ data: BrowserUseStatus }>(statusResponse);
      const sessionsData = await readJson<{ data: { sessions: BrowserUseSession[] } }>(sessionsResponse);
      const nextSessions = sessionsData.data.sessions;
      setStatus(statusData.data);
      setSessions(nextSessions);
      setSelectedSessionId((current) => (
        current && nextSessions.some((session) => session.id === current)
          ? current
          : nextSessions[0]?.id || null
      ));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Browser');
    } finally {
      if (!options.silent) {
        setIsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    void refresh();
  }, [isVisible, refresh]);

  // ethia fork: the device catalog is static, so fetch it once per mount.
  useEffect(() => {
    if (!isVisible || devices.length > 0) return;
    void (async () => {
      try {
        const response = await authenticatedFetch('/api/browser-use/devices');
        const data = await readJson<{ data: { devices: DevicePreset[] } }>(response);
        setDevices(data.data.devices);
      } catch {
        // A missing catalog only hides the picker; sessions still work.
      }
    })();
  }, [isVisible, devices.length]);

  const hasActiveSession = activeSessions.length > 0;

  const runAction = useCallback(async (action: () => Promise<void>) => {
    setIsBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Browser action failed');
    } finally {
      setIsBusy(false);
    }
  }, [refresh]);

  const stopSession = () => runAction(async () => {
    if (!selectedSession) return;
    const response = await authenticatedFetch(`/api/browser-use/sessions/${selectedSession.id}/stop`, { method: 'POST' });
    await readJson(response);
  });

  const deleteSession = () => runAction(async () => {
    if (!selectedSession) return;
    const response = await authenticatedFetch(`/api/browser-use/sessions/${selectedSession.id}`, { method: 'DELETE' });
    await readJson(response);
    setIsFullscreen(false);
  });

  const installBrowserBinaries = () => runAction(async () => {
    setIsInstalling(true);
    try {
      const response = await authenticatedFetch('/api/browser-use/runtime/install', { method: 'POST' });
      await readJson(response);
    } finally {
      setIsInstalling(false);
    }
  });

  // ethia fork: switch the live session between desktop and phone viewports.
  const applyDevice = (deviceId: string) => runAction(async () => {
    if (!selectedSession) return;
    const response = await authenticatedFetch(`/api/browser-use/sessions/${selectedSession.id}/emulate`, {
      method: 'POST',
      body: JSON.stringify({ device: deviceId }),
    });
    await readJson(response);
  });

  // ethia fork: interactive control of the selected live session. Inputs are
  // serialized through a queue so keystrokes reach the page in order.
  const isInteractive = selectedSession?.status === 'ready';

  const sendInput = useCallback(async (payload: Record<string, unknown>) => {
    const sessionId = selectedSession?.id;
    if (!sessionId) return;
    try {
      const response = await authenticatedFetch(`/api/browser-use/sessions/${sessionId}/input`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const data = await readJson<{ data: { session: BrowserUseSession } }>(response);
      const next = data.data.session;
      setSessions((current) => current.map((item) => (item.id === next.id ? next : item)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Browser input failed');
    }
  }, [selectedSession?.id]);

  const enqueueInput = useCallback((payload: Record<string, unknown>) => {
    inputQueueRef.current = inputQueueRef.current.then(() => sendInput(payload)).catch(() => undefined);
  }, [sendInput]);

  const handleSurfaceClick = (event: ReactMouseEvent<HTMLImageElement>) => {
    if (!isInteractive || !selectedSession?.viewport) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    (event.currentTarget.closest('div[tabindex]') as HTMLElement | null)?.focus();
    const x = ((event.clientX - rect.left) / rect.width) * selectedSession.viewport.width;
    const y = ((event.clientY - rect.top) / rect.height) * selectedSession.viewport.height;
    enqueueInput({ action: 'click', x: Math.round(x), y: Math.round(y) });
  };

  const handleSurfaceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isInteractive || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length === 1) {
      event.preventDefault();
      enqueueInput({ action: 'type', text: event.key, capture: false });
    } else if (INTERACTIVE_KEYS.has(event.key)) {
      event.preventDefault();
      enqueueInput({ action: 'key', key: event.key, capture: event.key === 'Enter' });
    }
  };

  const handleSurfacePaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (!isInteractive) return;
    const text = event.clipboardData.getData('text');
    if (!text) return;
    event.preventDefault();
    enqueueInput({ action: 'type', text });
  };

  const handleSurfaceWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!isInteractive) return;
    wheelDeltaRef.current += event.deltaY;
    if (wheelTimerRef.current) return;
    wheelTimerRef.current = setTimeout(() => {
      const delta = Math.round(wheelDeltaRef.current);
      wheelDeltaRef.current = 0;
      wheelTimerRef.current = null;
      if (delta) enqueueInput({ action: 'scroll', deltaY: delta });
    }, 250);
  };

  const handleNavigateSubmit = (event: FormEvent) => {
    event.preventDefault();
    const target = urlDraft.trim();
    if (!target || !isInteractive) return;
    enqueueInput({ action: 'navigate', url: target });
  };

  // ethia fork: keep the preview fresh while a session is live. A ready
  // session gets a real re-capture (screenshots are otherwise only taken on
  // actions, so a page that finishes loading would stay stale); other states
  // just re-fetch the session list.
  useEffect(() => {
    if (!isVisible || !hasActiveSession) return;
    const timer = setInterval(() => {
      if (isInteractive) {
        enqueueInput({ action: 'refresh' });
      } else {
        void refresh({ silent: true });
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [isVisible, hasActiveSession, isInteractive, enqueueInput, refresh]);

  // ethia fork: console/network for the selected session, polled only while the
  // DevTools drawer is open.
  const loadDevtools = useCallback(async (sessionId: string) => {
    try {
      const response = await authenticatedFetch(`/api/browser-use/sessions/${sessionId}/devtools?limit=200`);
      const data = await readJson<{ data: DevtoolsPayload }>(response);
      setDevtools(data.data);
    } catch (err) {
      setDevtools(null);
      setError(err instanceof Error ? err.message : 'Failed to read devtools');
    }
  }, []);

  useEffect(() => {
    if (!isVisible || !isDevtoolsOpen || !selectedSession?.id) {
      return;
    }
    void loadDevtools(selectedSession.id);
    const timer = setInterval(() => void loadDevtools(selectedSession.id), 3000);
    return () => clearInterval(timer);
  }, [isVisible, isDevtoolsOpen, selectedSession?.id, loadDevtools]);

  const renderSessionItem = (session: BrowserUseSession) => {
    const isSelected = selectedSession?.id === session.id;
    return (
      <button
        key={session.id}
        type="button"
        onClick={() => setSelectedSessionId(session.id)}
        className={cn(
          'group w-full rounded-md border px-3 py-2.5 text-left transition-colors',
          isSelected
            ? 'border-primary/50 bg-primary/10 text-foreground'
            : 'border-border/60 bg-card/30 text-muted-foreground hover:bg-muted/50',
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', getStatusDot(session.status))} />
              <div className="truncate text-sm font-medium">{session.title || getDomain(session.url)}</div>
            </div>
            <div className="mt-1 truncate pl-3.5 text-xs text-muted-foreground">{getDomain(session.url)}</div>
          </div>
          <Badge variant="outline" className="shrink-0 border-border bg-background text-[10px] text-muted-foreground">
            {session.status}
          </Badge>
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Clock3 className="h-3 w-3" />
          <span>{formatRelativeTime(session.updatedAt)}</span>
          <span className="truncate">- {formatAction(session.lastAction)}</span>
        </div>
      </button>
    );
  };

  const renderEmptyState = () => (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="w-full max-w-2xl rounded-md border border-border bg-card/40 p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-background">
            <MonitorPlay className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">
              {status?.enabled ? 'No browser sessions yet' : 'Browser is disabled'}
            </div>
            <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
              {status?.enabled
                ? 'Agent browser sessions appear here while an AI task is using Browser.'
                : 'Enable Browser in settings to let agents open monitored browser sessions.'}
            </p>
          </div>
        </div>

        {needsBrowserBinaries && (
          <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
            <div className="text-sm font-medium text-foreground">Runtime setup required</div>
            <p className="mt-1 text-sm text-muted-foreground">{status?.message}</p>
            <Button
              type="button"
              size="sm"
              className="mt-3"
              onClick={installBrowserBinaries}
              disabled={isBusy || isInstalling || status?.installInProgress}
            >
              {isInstalling || status?.installInProgress ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {isInstalling || status?.installInProgress ? 'Installing...' : 'Install Runtime'}
            </Button>
          </div>
        )}

        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          {PROMPTS.map((prompt) => (
            <div key={prompt} className="rounded-md border border-border/70 bg-background/70 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Bot className="h-3.5 w-3.5" />
                Prompt
              </div>
              <p className="text-sm leading-6 text-foreground">{prompt}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const renderBrowserSurface = (fullscreen = false) => (
    <div
      className={cn(
        'flex flex-1 items-center justify-center bg-neutral-950 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/40',
        fullscreen ? 'min-h-[80vh]' : isDevtoolsOpen ? 'min-h-[200px]' : 'min-h-[420px]',
      )}
      tabIndex={isInteractive ? 0 : -1}
      onKeyDown={handleSurfaceKeyDown}
      onPaste={handleSurfacePaste}
      onWheel={handleSurfaceWheel}
    >
      {selectedSession?.screenshotDataUrl ? (
        <div className="relative inline-block max-h-full">
          <img
            src={selectedSession.screenshotDataUrl}
            alt="Browser session screenshot"
            onClick={handleSurfaceClick}
            draggable={false}
            className={cn(
              'block w-auto max-w-full object-contain',
              fullscreen ? 'max-h-[80vh]' : isDevtoolsOpen ? 'max-h-[36vh]' : 'max-h-[72vh]',
              isInteractive && 'cursor-crosshair',
            )}
          />
          {cursorStyle && (
            <div
              className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/90 bg-primary/80 shadow-[0_0_0_6px_hsl(var(--primary)/0.18)]"
              style={cursorStyle}
            >
              <div className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" />
            </div>
          )}
        </div>
      ) : (
        <div className="px-6 text-center">
          <MonitorPlay className="mx-auto h-9 w-9 text-neutral-500" />
          <div className="mt-3 text-sm font-medium text-neutral-100">{selectedSession?.message || 'Waiting for screenshot'}</div>
          <p className="mt-1 text-xs text-neutral-400">The next agent browser snapshot will render here.</p>
        </div>
      )}
    </div>
  );

  // ethia fork: device picker for the selected session.
  const renderDevicePicker = () => {
    if (devices.length === 0) return null;
    const emulation = selectedSession?.emulation || null;
    const groups: Array<{ label: string; category: DevicePreset['category'] }> = [
      { label: 'Phone', category: 'phone' },
      { label: 'Tablet', category: 'tablet' },
      { label: 'Desktop', category: 'desktop' },
    ];

    return (
      <select
        value={emulation?.preset || ''}
        onChange={(event) => event.target.value && applyDevice(event.target.value)}
        disabled={isBusy || !isInteractive}
        title="Emulate a device viewport"
        aria-label="Emulate a device viewport"
        className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
      >
        {!emulation?.preset && (
          <option value="">
            {emulation ? emulation.label : 'Device'}
          </option>
        )}
        {groups.map((group) => (
          <optgroup key={group.category} label={group.label}>
            {devices
              .filter((device) => device.category === group.category)
              .map((device) => (
                <option key={device.id} value={device.id}>
                  {device.label} — {device.width}x{device.height}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    );
  };

  // ethia fork: console/network drawer mirroring what the agent can read.
  const renderDevtools = () => {
    const counts = devtools?.counts;
    const consoleEntries = devtools?.console || [];
    const networkEntries = devtools?.network || [];

    return (
      <div className="flex max-h-72 min-h-[180px] flex-col border-t border-border/60 bg-background">
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
          {(['console', 'network'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setDevtoolsTab(tab)}
              className={cn(
                'rounded-md px-2 py-1 text-xs font-medium capitalize transition-colors',
                devtoolsTab === tab ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/60',
              )}
            >
              {tab}
              {tab === 'console' && counts?.errors ? (
                <span className="ml-1.5 text-destructive">{counts.errors}</span>
              ) : null}
              {tab === 'network' && counts?.failedRequests ? (
                <span className="ml-1.5 text-destructive">{counts.failedRequests}</span>
              ) : null}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
            {counts && (
              <span>
                {counts.console} messages
                <span className="px-1">/</span>
                {counts.requests} requests
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={() => setIsDevtoolsOpen(false)}
              title="Close devtools"
              aria-label="Close devtools"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-5">
          {devtoolsTab === 'console' ? (
            consoleEntries.length === 0 ? (
              <div className="p-3 font-sans text-xs text-muted-foreground">No console output captured yet.</div>
            ) : (
              consoleEntries.map((entry) => (
                <div
                  key={entry.id}
                  className={cn(
                    'flex gap-2 border-b border-border/40 px-3 py-1',
                    (entry.type === 'error' || entry.type === 'pageerror') && 'bg-destructive/5 text-destructive',
                    entry.type === 'warning' && 'bg-amber-500/5 text-amber-600 dark:text-amber-400',
                  )}
                >
                  <span className="shrink-0 uppercase opacity-70">{entry.type}</span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{entry.text}</span>
                  {entry.location && (
                    <span className="hidden shrink-0 truncate text-muted-foreground md:block md:max-w-[220px]">
                      {entry.location}
                    </span>
                  )}
                </div>
              ))
            )
          ) : networkEntries.length === 0 ? (
            <div className="p-3 font-sans text-xs text-muted-foreground">No requests captured yet.</div>
          ) : (
            networkEntries.map((entry) => {
              const failed = entry.failure !== null || (entry.status !== null && entry.status >= 400);
              return (
                <div
                  key={entry.id}
                  className={cn(
                    'flex items-center gap-2 border-b border-border/40 px-3 py-1',
                    failed && 'bg-destructive/5 text-destructive',
                  )}
                >
                  <span className="w-12 shrink-0 opacity-70">{entry.method}</span>
                  <span className="w-10 shrink-0">{entry.status ?? (entry.failure ? 'ERR' : '...')}</span>
                  <span className="min-w-0 flex-1 truncate" title={entry.url}>{entry.url}</span>
                  <span className="hidden w-20 shrink-0 text-right text-muted-foreground sm:block">
                    {entry.resourceType}
                  </span>
                  <span className="w-14 shrink-0 text-right text-muted-foreground">
                    {typeof entry.durationMs === 'number' ? `${entry.durationMs}ms` : ''}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <MonitorPlay className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Browser</h3>
            <Badge variant="outline" className={cn('text-[10px]', getRuntimeTone(status, isInstalling))}>
              {runtimeLabel}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">Monitor and control browser sessions opened by AI agents — click the preview to interact.</p>
        </div>
        <div className="flex items-center gap-1.5">
          {onShowSettings && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => onShowSettings('browser')}
              title="Open Browser settings"
              aria-label="Open Browser settings"
            >
              <Settings className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => void refresh()}
            disabled={isRefreshing || isBusy}
            title="Refresh browser sessions"
            aria-label="Refresh browser sessions"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {error && (
        <div className="border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {sessions.length > 0 && (
        <div className="border-b border-border/60 bg-muted/20 px-3 py-2 lg:hidden">
          <div className="flex gap-2 overflow-x-auto">
            {sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => setSelectedSessionId(session.id)}
                className={cn(
                  'flex min-w-[180px] items-center gap-2 rounded-md border px-2.5 py-2 text-left',
                  selectedSession?.id === session.id
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-border bg-background',
                )}
              >
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', getStatusDot(session.status))} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                  {session.title || getDomain(session.url)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]">
        <main className="flex min-h-0 flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground">
            <div className="min-w-0 truncate">
              {activeSessions.length} active
              <span className="px-1.5">/</span>
              {sessions.length} total
            </div>
            <div className="min-w-0 truncate">
              Updated {formatRelativeTime(selectedSession?.updatedAt || null)}
            </div>
          </div>

          {sessions.length === 0 ? (
            renderEmptyState()
          ) : (
            <div className="min-h-0 flex-1 overflow-auto bg-muted/20 p-4">
              <div
                className={cn(
                  'mx-auto flex max-w-7xl flex-col overflow-hidden rounded-md border border-border bg-background shadow-sm',
                  isDevtoolsOpen ? 'min-h-[420px]' : 'min-h-[500px]',
                )}
              >
                <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
                  <Badge variant="outline" className={selectedSession ? cn('text-[10px]', getStatusTone(selectedSession.status)) : 'text-[10px]'}>
                    {selectedSession?.status || 'empty'}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {selectedSession?.title || getDomain(selectedSession?.url || null)}
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{selectedSession?.url || 'No page loaded'}</span>
                    </div>
                  </div>
                  <div className="hidden text-xs text-muted-foreground md:block">
                    {formatAction(selectedSession?.lastAction || null)}
                  </div>
                  {isInteractive && (
                    <form onSubmit={handleNavigateSubmit} className="flex items-center">
                      <input
                        value={urlDraft}
                        onChange={(event) => setUrlDraft(event.target.value)}
                        placeholder="Open URL..."
                        className="h-8 w-36 rounded-md border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary md:w-56"
                      />
                    </form>
                  )}
                  {renderDevicePicker()}
                  {selectedSession?.viewport && (
                    <Badge variant="outline" className="hidden text-[10px] text-muted-foreground sm:inline-flex">
                      {selectedSession.viewport.width}x{selectedSession.viewport.height}
                      {selectedSession.emulation?.hasTouch ? ' touch' : ''}
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn('h-8 w-8 p-0', isDevtoolsOpen && 'bg-primary/10 text-foreground')}
                    onClick={() => setIsDevtoolsOpen((current) => !current)}
                    disabled={!selectedSession || selectedSession.status !== 'ready'}
                    title="Console and network"
                    aria-label="Console and network"
                  >
                    <Terminal className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setIsFullscreen(true)} disabled={!selectedSession?.screenshotDataUrl} title="Full screen" aria-label="Full screen">
                    <Expand className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0 lg:hidden" onClick={stopSession} disabled={isBusy || !selectedSession || selectedSession.status !== 'ready'} title="Stop session" aria-label="Stop session">
                    <Square className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0 lg:hidden" onClick={deleteSession} disabled={isBusy || !selectedSession} title="Delete session" aria-label="Delete session">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                {renderBrowserSurface()}
                {isDevtoolsOpen && renderDevtools()}
              </div>
            </div>
          )}
        </main>

        <aside className="hidden min-h-0 flex-col border-l border-border/60 bg-background lg:flex">
          <div className="border-b border-border/60 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-foreground">Sessions</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{sessions.length} total</div>
              </div>
              <Badge variant="outline" className="text-[10px]">{activeSessions.length} active</Badge>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {sessions.length > 0 ? (
              <div className="space-y-2">{sessions.map(renderSessionItem)}</div>
            ) : (
              <div className="rounded-md border border-dashed border-border/70 px-3 py-8 text-center text-xs text-muted-foreground">
                No agent browser sessions.
              </div>
            )}
          </div>

          <div className="border-t border-border/60 p-3">
            <div className="rounded-md border border-border/70 bg-muted/30 p-3">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Bot className="h-3.5 w-3.5" />
                Selected
              </div>
              <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                <div className="flex items-center justify-between gap-3">
                  <span>Status</span>
                  <span className="font-medium text-foreground">{selectedSession?.status || 'None'}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>Last action</span>
                  <span className="truncate font-medium text-foreground">{formatAction(selectedSession?.lastAction || null)}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>Profile</span>
                  <span className="truncate font-medium text-foreground">{selectedSession?.profileName || 'Temporary'}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>Device</span>
                  <span className="truncate font-medium text-foreground">
                    {selectedSession?.emulation?.label || 'Desktop'}
                  </span>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button variant="outline" size="sm" onClick={stopSession} disabled={isBusy || !selectedSession || selectedSession.status !== 'ready'}>
                  <Square className="h-4 w-4" />
                  Stop
                </Button>
                <Button variant="outline" size="sm" onClick={deleteSession} disabled={isBusy || !selectedSession}>
                  <Trash2 className="h-4 w-4" />
                  Delete
                </Button>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {isFullscreen && selectedSession && (
        <div className="fixed inset-0 z-50 bg-black/90 p-6">
          <div className="flex h-full flex-col rounded-md border border-white/10 bg-black">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 text-sm text-white/80">
              <div className="min-w-0 truncate">{selectedSession.title || selectedSession.url || 'Browser session'}</div>
              <Button variant="outline" size="sm" onClick={() => setIsFullscreen(false)}>
                <X className="h-4 w-4" />
                Close
              </Button>
            </div>
            {renderBrowserSurface(true)}
          </div>
        </div>
      )}
    </div>
  );
}

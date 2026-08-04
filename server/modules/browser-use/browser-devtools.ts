// ethia fork: DevTools capture for agent browser sessions.
//
// Playwright only surfaces console output, page errors and network activity as
// events while a page is alive. Agents poll instead of listening, so every
// session keeps a bounded ring buffer that tools read from.

export type ConsoleEntry = {
  id: number;
  type: string;
  text: string;
  location: string | null;
  timestamp: string;
};

export type NetworkEntry = {
  id: number;
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  statusText: string | null;
  ok: boolean | null;
  fromServiceWorker: boolean;
  failure: string | null;
  durationMs: number | null;
  startedAt: string;
};

export const CONSOLE_LIMIT = 500;
export const NETWORK_LIMIT = 400;
const TEXT_LIMIT = 4_000;
const URL_LIMIT = 2_000;

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

export class DevtoolsRecorder {
  private consoleEntries: ConsoleEntry[] = [];

  private networkEntries: NetworkEntry[] = [];

  private nextId = 1;

  private pending = new WeakMap<object, { entry: NetworkEntry; startedAt: number }>();

  /** Monotonic-ish clock injected in tests so durations stay deterministic. */
  constructor(private now: () => number = () => Date.now()) {}

  addConsole(input: { type: string; text: string; location?: string | null }): ConsoleEntry {
    const entry: ConsoleEntry = {
      id: this.nextId++,
      type: String(input.type || 'log'),
      text: truncate(String(input.text ?? ''), TEXT_LIMIT),
      location: input.location ? truncate(String(input.location), 300) : null,
      timestamp: new Date(this.now()).toISOString(),
    };
    this.consoleEntries.push(entry);
    if (this.consoleEntries.length > CONSOLE_LIMIT) {
      this.consoleEntries.splice(0, this.consoleEntries.length - CONSOLE_LIMIT);
    }
    return entry;
  }

  startRequest(request: object, input: { method: string; url: string; resourceType: string }): NetworkEntry {
    const startedAt = this.now();
    const entry: NetworkEntry = {
      id: this.nextId++,
      method: String(input.method || 'GET').toUpperCase(),
      url: truncate(String(input.url || ''), URL_LIMIT),
      resourceType: String(input.resourceType || 'other'),
      status: null,
      statusText: null,
      ok: null,
      fromServiceWorker: false,
      failure: null,
      durationMs: null,
      startedAt: new Date(startedAt).toISOString(),
    };
    this.pending.set(request, { entry, startedAt });
    this.networkEntries.push(entry);
    if (this.networkEntries.length > NETWORK_LIMIT) {
      this.networkEntries.splice(0, this.networkEntries.length - NETWORK_LIMIT);
    }
    return entry;
  }

  finishRequest(request: object, input: { status?: number | null; statusText?: string | null; fromServiceWorker?: boolean }) {
    const pending = this.pending.get(request);
    if (!pending) {
      return;
    }
    const { entry, startedAt } = pending;
    if (typeof input.status === 'number') {
      entry.status = input.status;
      entry.ok = input.status < 400;
    }
    entry.statusText = input.statusText ? truncate(String(input.statusText), 200) : entry.statusText;
    entry.fromServiceWorker = input.fromServiceWorker === true;
    entry.durationMs = Math.max(0, Math.round(this.now() - startedAt));
  }

  failRequest(request: object, failure: string | null) {
    const pending = this.pending.get(request);
    if (!pending) {
      return;
    }
    const { entry, startedAt } = pending;
    entry.failure = truncate(String(failure || 'Request failed'), 300);
    entry.ok = false;
    entry.durationMs = Math.max(0, Math.round(this.now() - startedAt));
  }

  getConsole(options: { level?: string | null; search?: string | null; limit?: number | null } = {}) {
    const level = String(options.level || '').toLowerCase();
    const search = String(options.search || '').toLowerCase();
    let entries = this.consoleEntries;

    if (level && level !== 'all') {
      // "error" also covers uncaught page exceptions, which agents care about most.
      const wanted = level === 'error' ? new Set(['error', 'pageerror']) : new Set([level]);
      entries = entries.filter((entry) => wanted.has(entry.type));
    }
    if (search) {
      entries = entries.filter((entry) => entry.text.toLowerCase().includes(search));
    }
    return tail(entries, options.limit, 100);
  }

  getNetwork(options: {
    urlContains?: string | null;
    onlyFailed?: boolean | null;
    resourceType?: string | null;
    limit?: number | null;
  } = {}) {
    let entries = this.networkEntries;
    const urlContains = String(options.urlContains || '').toLowerCase();

    if (urlContains) {
      entries = entries.filter((entry) => entry.url.toLowerCase().includes(urlContains));
    }
    if (options.resourceType) {
      const wanted = String(options.resourceType).toLowerCase();
      entries = entries.filter((entry) => entry.resourceType.toLowerCase() === wanted);
    }
    if (options.onlyFailed) {
      entries = entries.filter((entry) => entry.failure !== null || (entry.status !== null && entry.status >= 400));
    }
    return tail(entries, options.limit, 50);
  }

  counts() {
    const errors = this.consoleEntries.filter((entry) => entry.type === 'error' || entry.type === 'pageerror').length;
    const warnings = this.consoleEntries.filter((entry) => entry.type === 'warning' || entry.type === 'warn').length;
    const failedRequests = this.networkEntries.filter(
      (entry) => entry.failure !== null || (entry.status !== null && entry.status >= 400),
    ).length;
    return {
      console: this.consoleEntries.length,
      errors,
      warnings,
      requests: this.networkEntries.length,
      failedRequests,
    };
  }

  clear() {
    this.consoleEntries = [];
    this.networkEntries = [];
    this.pending = new WeakMap();
  }
}

function tail<T>(entries: T[], limit: number | null | undefined, fallback: number): T[] {
  const size = Number.isFinite(limit as number) && Number(limit) > 0
    ? Math.min(Math.floor(Number(limit)), CONSOLE_LIMIT)
    : fallback;
  return entries.slice(-size);
}

/**
 * Wire a Playwright page into a recorder. Returns a detach function; listeners
 * are also dropped automatically when the page closes.
 */
export function attachPageRecorder(page: any, recorder: DevtoolsRecorder): () => void {
  const onConsole = (message: any) => {
    let location: string | null = null;
    try {
      const raw = message.location?.();
      location = raw?.url ? `${raw.url}:${raw.lineNumber ?? 0}:${raw.columnNumber ?? 0}` : null;
    } catch {
      location = null;
    }
    recorder.addConsole({ type: message.type?.() || 'log', text: message.text?.() ?? '', location });
  };

  const onPageError = (error: any) => {
    const text = error?.stack || error?.message || String(error);
    recorder.addConsole({ type: 'pageerror', text });
  };

  const onRequest = (request: any) => {
    recorder.startRequest(request, {
      method: request.method?.() || 'GET',
      url: request.url?.() || '',
      resourceType: request.resourceType?.() || 'other',
    });
  };

  const onResponse = (response: any) => {
    const request = response.request?.();
    if (!request) {
      return;
    }
    recorder.finishRequest(request, {
      status: response.status?.() ?? null,
      statusText: response.statusText?.() ?? null,
      fromServiceWorker: response.fromServiceWorker?.() === true,
    });
  };

  const onRequestFailed = (request: any) => {
    recorder.failRequest(request, request.failure?.()?.errorText || 'Request failed');
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  const detach = () => {
    page.off?.('console', onConsole);
    page.off?.('pageerror', onPageError);
    page.off?.('request', onRequest);
    page.off?.('response', onResponse);
    page.off?.('requestfailed', onRequestFailed);
  };

  page.once?.('close', detach);
  return detach;
}

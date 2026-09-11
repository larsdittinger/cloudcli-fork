import type { BrowserEmulation } from './browser-emulation.js';
import { defaultEmulation, isStealthDesktop } from './browser-emulation.js';

/**
 * ethia fork: pripojeni na REALNY Chrome bezici mimo instanci (typicky na
 * notebooku uzivatele, dostupny pres reverzni SSH tunel) pres CDP.
 *
 * Duvod: agent pak jede v prohlizeci, kde je uzivatel prihlaseny — vcetne 2FA a
 * session, ktere by v kontejneru musel poklikat znovu. Kdyz endpoint neodpovi
 * (notebook spi, tunel spadl), launch tise spadne zpet na patchright Chrome
 * uvnitr instance, takze agentovi se prace nikdy nezastavi.
 */

export const DEFAULT_CDP_TIMEOUT_MS = 1_000;
const MIN_CDP_TIMEOUT_MS = 100;
const MAX_CDP_TIMEOUT_MS = 10_000;

export type CdpConfig = {
  url: string | null;
  timeoutMs: number;
};

type ProbeResult = {
  ok: boolean;
  browser?: string;
  reason?: string;
};

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status?: number;
  json: () => Promise<any>;
}>;

/**
 * Normalizuje CLOUDCLI_BROWSER_CDP_URL na `http(s)://host:port` bez koncoveho
 * lomitka. Nepouzitelna hodnota znamena "CDP vypnuto" — nikdy vyjimku, protoze
 * tohle bezi na ceste ke spusteni prohlizece a preklep v .env nesmi shodit
 * browser cele instance.
 */
export function readCdpConfig(env: Record<string, string | undefined>): CdpConfig {
  const timeoutMs = readTimeout(env.CLOUDCLI_BROWSER_CDP_TIMEOUT_MS);
  const raw = String(env.CLOUDCLI_BROWSER_CDP_URL || '').trim();
  if (!raw) {
    return { url: null, timeoutMs };
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { url: null, timeoutMs };
  }

  // CDP se probuje pres HTTP /json/version; ws:// endpoint by probe nikdy nepresel.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { url: null, timeoutMs };
  }
  if (!parsed.hostname) {
    return { url: null, timeoutMs };
  }

  return { url: `${parsed.protocol}//${parsed.host}`, timeoutMs };
}

function readTimeout(raw: string | undefined): number {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CDP_TIMEOUT_MS;
  }
  return Math.min(MAX_CDP_TIMEOUT_MS, Math.max(MIN_CDP_TIMEOUT_MS, parsed));
}

/**
 * Zjisti, jestli na endpointu opravdu sedi Chrome s otevrenym debug portem.
 * Kratky timeout je zamer: kdyz notebook spi, nesmi se zakladani session zdrzet.
 */
export async function probeCdp(
  url: string,
  options: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!fetchImpl) {
    return { ok: false, reason: 'fetch is not available in this runtime' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${url}/json/version`, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status ?? '?'}` };
    }
    const payload = await response.json();
    const browser = typeof payload?.Browser === 'string' ? payload.Browser : null;
    if (!browser && !payload?.webSocketDebuggerUrl) {
      return { ok: false, reason: 'endpoint neodpovida jako Chrome DevTools' };
    }
    return { ok: true, browser: browser || 'Chrome' };
  } catch (error: any) {
    return { ok: false, reason: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Emulace zarizeni (iPhone, vlastni rozmer) potrebuje vlastni browser context s
 * viewportem a UA — na cizim, uz bezicim Chromu ji nejde nastavit, aniz by se
 * sahlo na okna uzivatele. Stealth desktop bezi s viewport:null, takze i pouha
 * zmena rozmeru je pozadavek, ktery pripojeny Chrome nesplni. Takova session
 * proto jede v patchrightu.
 */
export function supportsCdpTarget(emulation: BrowserEmulation): boolean {
  if (!isStealthDesktop(emulation)) {
    return false;
  }
  const base = defaultEmulation();
  return emulation.width === base.width && emulation.height === base.height;
}

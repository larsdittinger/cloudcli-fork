// ethia fork: device emulation for agent browser sessions.
//
// Upstream hardcodes a 1440x900 desktop context, so agents cannot check how a
// page behaves on a phone. This module turns loose tool input ("iphone 15",
// {width: 390, height: 844}) into a normalized descriptor that both the
// Playwright context options and the session payload are built from.

export type DevicePlatform = 'iOS' | 'Android';

export type BrowserEmulation = {
  /** Preset id when the emulation came from the catalog, null for custom sizes. */
  preset: string | null;
  label: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  landscape: boolean;
  userAgent: string | null;
  /**
   * Platform the emulated device claims. Drives the Sec-CH-UA client hints and
   * navigator.platform, which a spoofed user agent alone leaves inconsistent —
   * server-side detection reads the hints on modern Chromium.
   */
  platform: DevicePlatform | null;
};

export type EmulationInput = {
  device?: string | null;
  width?: number | null;
  height?: number | null;
  deviceScaleFactor?: number | null;
  isMobile?: boolean | null;
  hasTouch?: boolean | null;
  landscape?: boolean | null;
  userAgent?: string | null;
};

type DevicePreset = Omit<BrowserEmulation, 'preset' | 'landscape'> & {
  id: string;
  category: 'phone' | 'tablet' | 'desktop';
};

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';

export const DEVICE_PRESETS: DevicePreset[] = [
  {
    id: 'iphone-se',
    label: 'iPhone SE',
    category: 'phone',
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: IOS_UA,
    platform: 'iOS',
  },
  {
    id: 'iphone-13',
    label: 'iPhone 13',
    category: 'phone',
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: IOS_UA,
    platform: 'iOS',
  },
  {
    id: 'iphone-15',
    label: 'iPhone 15',
    category: 'phone',
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: IOS_UA,
    platform: 'iOS',
  },
  {
    id: 'iphone-15-pro-max',
    label: 'iPhone 15 Pro Max',
    category: 'phone',
    width: 430,
    height: 932,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: IOS_UA,
    platform: 'iOS',
  },
  {
    id: 'pixel-7',
    label: 'Pixel 7',
    category: 'phone',
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    userAgent: ANDROID_UA,
    platform: 'Android',
  },
  {
    id: 'galaxy-s20',
    label: 'Galaxy S20',
    category: 'phone',
    width: 360,
    height: 800,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: ANDROID_UA,
    platform: 'Android',
  },
  {
    id: 'ipad-mini',
    label: 'iPad Mini',
    category: 'tablet',
    width: 768,
    height: 1024,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: IPAD_UA,
    platform: 'iOS',
  },
  {
    id: 'ipad-pro-11',
    label: 'iPad Pro 11"',
    category: 'tablet',
    width: 834,
    height: 1194,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: IPAD_UA,
    platform: 'iOS',
  },
  {
    id: 'desktop',
    label: 'Desktop',
    category: 'desktop',
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    userAgent: null,
    platform: null,
  },
  {
    id: 'desktop-small',
    label: 'Desktop small',
    category: 'desktop',
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    userAgent: null,
    platform: null,
  },
  {
    id: 'desktop-hd',
    label: 'Desktop HD',
    category: 'desktop',
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    userAgent: null,
    platform: null,
  },
];

export const DEFAULT_PRESET_ID = 'desktop';

const MIN_DIMENSION = 200;
const MAX_DIMENSION = 3840;
const MIN_SCALE = 0.5;
const MAX_SCALE = 4;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/["'”’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Aliases so agents can say "iphone", "mobile", "android" and still land on a
// sensible preset instead of an error.
const PRESET_ALIASES: Record<string, string> = {
  mobile: 'iphone-15',
  phone: 'iphone-15',
  iphone: 'iphone-15',
  'iphone-15-pro': 'iphone-15',
  'iphone-14': 'iphone-13',
  'iphone-12': 'iphone-13',
  'iphone-se-2020': 'iphone-se',
  android: 'pixel-7',
  pixel: 'pixel-7',
  'pixel-5': 'pixel-7',
  galaxy: 'galaxy-s20',
  samsung: 'galaxy-s20',
  tablet: 'ipad-mini',
  ipad: 'ipad-mini',
  'ipad-pro': 'ipad-pro-11',
  laptop: 'desktop',
  computer: 'desktop',
  'desktop-large': 'desktop-hd',
  full: 'desktop-hd',
  hd: 'desktop-hd',
};

const compact = (value: string) => value.replace(/-/g, '');

export function findPreset(name: string | null | undefined): DevicePreset | null {
  const slug = slugify(String(name || ''));
  if (!slug) {
    return null;
  }

  const resolved = PRESET_ALIASES[slug] || slug;
  const direct = DEVICE_PRESETS.find((preset) => preset.id === resolved);
  if (direct) {
    return direct;
  }

  // Tolerate spacing-free spellings such as "iphone15" or "ipadmini".
  const compactSlug = compact(resolved);
  const aliasEntry = Object.entries(PRESET_ALIASES).find(([alias]) => compact(alias) === compactSlug);
  const target = aliasEntry ? aliasEntry[1] : compactSlug;
  return DEVICE_PRESETS.find((preset) => preset.id === target || compact(preset.id) === compact(target)) || null;
}

export function listPresets() {
  return DEVICE_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    category: preset.category,
    width: preset.width,
    height: preset.height,
    deviceScaleFactor: preset.deviceScaleFactor,
    isMobile: preset.isMobile,
    hasTouch: preset.hasTouch,
  }));
}

function clampDimension(value: number): number {
  return Math.round(Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, value)));
}

function toEmulation(preset: DevicePreset): BrowserEmulation {
  return {
    preset: preset.id,
    label: preset.label,
    width: preset.width,
    height: preset.height,
    deviceScaleFactor: preset.deviceScaleFactor,
    isMobile: preset.isMobile,
    hasTouch: preset.hasTouch,
    landscape: false,
    userAgent: preset.userAgent,
    platform: preset.platform,
  };
}

export function defaultEmulation(): BrowserEmulation {
  const preset = findPreset(DEFAULT_PRESET_ID);
  if (!preset) {
    throw new Error(`Missing default device preset "${DEFAULT_PRESET_ID}".`);
  }
  return toEmulation(preset);
}

function applyLandscape(emulation: BrowserEmulation): BrowserEmulation {
  if (!emulation.landscape || emulation.width >= emulation.height) {
    return emulation;
  }
  return { ...emulation, width: emulation.height, height: emulation.width };
}

/**
 * Merge tool input onto a base emulation. A known device name resets every
 * field to that preset; explicit width/height/scale/touch overrides win on top.
 * Throws on an unknown device name so agents get a usable error instead of a
 * silent desktop fallback.
 */
export function resolveEmulation(input: EmulationInput = {}, base: BrowserEmulation = defaultEmulation()): BrowserEmulation {
  const requestedDevice = typeof input.device === 'string' ? input.device.trim() : '';
  let next: BrowserEmulation = { ...base, landscape: false };

  if (requestedDevice) {
    const preset = findPreset(requestedDevice);
    if (!preset) {
      throw new Error(
        `Unknown device "${requestedDevice}". Available: ${DEVICE_PRESETS.map((item) => item.id).join(', ')}, `
        + 'or pass width/height for a custom viewport.',
      );
    }
    next = toEmulation(preset);
  }

  const hasCustomSize = Number.isFinite(input.width as number) || Number.isFinite(input.height as number);
  if (hasCustomSize) {
    const width = Number.isFinite(input.width as number) ? clampDimension(Number(input.width)) : next.width;
    const height = Number.isFinite(input.height as number) ? clampDimension(Number(input.height)) : next.height;
    // A hand-picked size only keeps its preset name when everything else still
    // matches that device — a desktop context resized to 375x667 is not an
    // iPhone SE and must not claim to be one.
    const matching = DEVICE_PRESETS.find((preset) => preset.width === width
      && preset.height === height
      && preset.deviceScaleFactor === next.deviceScaleFactor
      && preset.isMobile === next.isMobile
      && preset.hasTouch === next.hasTouch
      && preset.userAgent === next.userAgent);
    next = {
      ...next,
      width,
      height,
      preset: matching?.id || null,
      label: matching?.label || `Custom ${width}x${height}`,
    };
  }

  if (Number.isFinite(input.deviceScaleFactor as number)) {
    next.deviceScaleFactor = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(input.deviceScaleFactor)));
  }
  if (typeof input.isMobile === 'boolean') {
    next.isMobile = input.isMobile;
    // Touch follows the mobile flag unless the caller pins it explicitly.
    if (typeof input.hasTouch !== 'boolean') {
      next.hasTouch = input.isMobile;
    }
  }
  if (typeof input.hasTouch === 'boolean') {
    next.hasTouch = input.hasTouch;
  }
  if (typeof input.userAgent === 'string') {
    const trimmed = input.userAgent.trim();
    next.userAgent = trimmed ? trimmed.slice(0, 512) : null;
    // Keep the client hints in step with a hand-written user agent.
    next.platform = platformFromUserAgent(next.userAgent);
  }
  if (input.landscape === true) {
    next.landscape = true;
    next = applyLandscape(next);
    next.preset = next.preset && DEVICE_PRESETS.some((preset) => preset.id === next.preset) ? next.preset : null;
    if (!hasCustomSize && !next.label.startsWith('Custom')) {
      next.label = `${next.label} (landscape)`;
    }
  }

  if (!hasCustomSize && !requestedDevice && base.landscape) {
    // Preserve an already-applied landscape flip when only unrelated fields change.
    next.landscape = true;
  }

  return next;
}

export function platformFromUserAgent(userAgent: string | null): DevicePlatform | null {
  if (!userAgent) {
    return null;
  }
  if (/iPhone|iPad|iPod/i.test(userAgent)) {
    return 'iOS';
  }
  return /Android/i.test(userAgent) ? 'Android' : null;
}

/** What navigator.platform should say for the emulated device. */
export function navigatorPlatform(emulation: BrowserEmulation): string | null {
  if (emulation.platform === 'Android') {
    return 'Linux armv81';
  }
  if (emulation.platform !== 'iOS') {
    return null;
  }
  return /iPad/i.test(emulation.userAgent || '') ? 'iPad' : 'iPhone';
}

/**
 * Sec-CH-UA client hints matching the emulated device. Chromium keeps sending
 * its own hints when only the user agent string is overridden, so server-side
 * detection would still see a desktop headless browser.
 */
export function toClientHintHeaders(emulation: BrowserEmulation): Record<string, string> {
  if (!emulation.platform) {
    return {};
  }
  return {
    'sec-ch-ua-mobile': emulation.isMobile ? '?1' : '?0',
    'sec-ch-ua-platform': `"${emulation.platform}"`,
  };
}

/** Playwright browser-context options for an emulation descriptor. */
export function toContextOptions(emulation: BrowserEmulation) {
  const options: Record<string, unknown> = {
    viewport: { width: emulation.width, height: emulation.height },
    deviceScaleFactor: emulation.deviceScaleFactor,
    isMobile: emulation.isMobile,
    hasTouch: emulation.hasTouch,
  };
  if (emulation.userAgent) {
    options.userAgent = emulation.userAgent;
  }
  const headers = toClientHintHeaders(emulation);
  if (Object.keys(headers).length > 0) {
    options.extraHTTPHeaders = headers;
  }
  return options;
}

/**
 * True when the change only affects the viewport box, which Playwright can
 * apply in place via page.setViewportSize() — no context restart, no lost page.
 */
export function isViewportOnlyChange(current: BrowserEmulation, next: BrowserEmulation): boolean {
  return current.deviceScaleFactor === next.deviceScaleFactor
    && current.isMobile === next.isMobile
    && current.hasTouch === next.hasTouch
    && current.userAgent === next.userAgent
    && current.platform === next.platform
    && (current.width !== next.width || current.height !== next.height);
}

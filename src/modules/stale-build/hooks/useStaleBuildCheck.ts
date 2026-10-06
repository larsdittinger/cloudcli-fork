import { useCallback, useEffect, useRef, useState } from 'react';

import type { ServerEvent } from '@/shared/types';

/** How often an idle tab looks for a new deploy without any other trigger. */
const PERIODIC_CHECK_MS = 10 * 60 * 1000;
/** Visibility flips and reconnect storms must not turn into a request each. */
const MIN_CHECK_INTERVAL_MS = 30 * 1000;
/** Vite's hashed entry chunk, as referenced from index.html. */
const ENTRY_BUNDLE_PATTERN = /\/assets\/index-[^"'/]+\.js/;

type UseStaleBuildCheckArgs = {
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
};

/** The entry bundle this tab is running, or null in vite dev (no hashed bundle). */
function readLoadedEntryBundle(): string | null {
  const scripts = document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]');
  for (const script of scripts) {
    const { pathname } = new URL(script.src, window.location.href);
    if (ENTRY_BUNDLE_PATTERN.test(pathname)) return pathname;
  }
  return null;
}

/** The entry bundle the server hands out now, or null when that cannot be told. */
async function fetchServedEntryBundle(loadedBundlePath: string): Promise<string | null> {
  // index.html lives next to the assets directory, which keeps a path prefix
  // (an app served under /ai/) working without knowing the router basename.
  const indexPath = loadedBundlePath.replace(ENTRY_BUNDLE_PATTERN, '/');
  try {
    const response = await fetch(indexPath, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return null;
    const match = (await response.text()).match(ENTRY_BUNDLE_PATTERN);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * Tells whether the server now serves a different build than this tab runs.
 *
 * A deploy restarts the server, but open tabs only reconnect their websocket
 * and keep the old code for hours — fixes never reach them, and old code
 * talking to a new server breaks in ways nobody can see. The tab never reloads
 * by itself: the Files editor, attachments and settings forms hold unsaved
 * state that no draft keeps, so the user decides when (`isStale` → banner).
 */
export function useStaleBuildCheck({ subscribe }: UseStaleBuildCheckArgs) {
  // Whether a newer build is deployed; drives the reload banner.
  const [isStale, setIsStale] = useState(false);
  const isStaleRef = useRef(false);
  const lastCheckAtRef = useRef(0);

  const check = useCallback(async ({ force = false }: { force?: boolean } = {}) => {
    if (isStaleRef.current) return;
    const loaded = readLoadedEntryBundle();
    if (!loaded) return;
    // A reconnect is the deploy itself, so it is never throttled away.
    if (!force && Date.now() - lastCheckAtRef.current < MIN_CHECK_INTERVAL_MS) return;

    const served = await fetchServedEntryBundle(loaded);
    if (!served) return; // a failed check proves nothing and must not use up the window
    lastCheckAtRef.current = Date.now();
    if (!loaded.endsWith(served)) {
      isStaleRef.current = true;
      setIsStale(true);
    }
  }, []);

  useEffect(() => subscribe((event) => {
    // The server restarted (a deploy does that) — the moment a new build appears.
    if (event.kind === 'websocket_reconnected') {
      void check({ force: true });
    }
  }), [subscribe, check]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void check();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const interval = window.setInterval(() => { void check(); }, PERIODIC_CHECK_MS);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.clearInterval(interval);
    };
  }, [check]);

  return { isStale };
}

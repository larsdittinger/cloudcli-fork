import { useEffect } from 'react';
import type { RefObject } from 'react';

import { createScrollAnchor } from '@/modules/chat/utils/scrollAnchor';

/**
 * Keeps the message the user is reading still while content above it changes
 * height, and the newest message in view while the user is at the bottom —
 * see `createScrollAnchor`. The anchor is re-checked after every scroll and
 * every size change of the rows' wrapper or the pane (keyboard, composer).
 * Does nothing where ResizeObserver is missing (jsdom).
 */
export function useTranscriptScrollAnchor(
  scrollContainerRef: RefObject<HTMLDivElement>,
  contentRef: RefObject<HTMLDivElement>,
): void {
  useEffect(() => {
    const container = scrollContainerRef.current;
    const content = contentRef.current;
    if (!container || !content || typeof ResizeObserver === 'undefined') return undefined;

    const anchor = createScrollAnchor(container, content);
    anchor.rebase();

    const resizeObserver = new ResizeObserver(() => anchor.settle());
    resizeObserver.observe(content);
    resizeObserver.observe(container);
    // Capture phase: runs before React's root listener applies the click.
    const handleClick = (event: MouseEvent) => anchor.holdClicked(event.target);
    container.addEventListener('scroll', anchor.settleAfterScroll, { passive: true });
    container.addEventListener('click', handleClick, true);

    return () => {
      resizeObserver.disconnect();
      container.removeEventListener('scroll', anchor.settleAfterScroll);
      container.removeEventListener('click', handleClick, true);
    };
  }, [scrollContainerRef, contentRef]);
}

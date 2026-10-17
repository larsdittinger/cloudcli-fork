/**
 * Scroll anchoring for the chat transcript, done by hand.
 *
 * Content above the viewport changes height all the time: a lazy row mounts
 * over its estimated placeholder, an older page is prepended, the first loaded
 * message loses its "Claude" header once an older one lands above it, the
 * "load all" pill appears at the top, an image finishes loading. Chromium and
 * Firefox keep the visible message still through CSS scroll anchoring; stable
 * Safari (macOS and iOS) has none, so on an iPhone each of those changes threw
 * the transcript up or down by hundreds of pixels while the user scrolled.
 *
 * This remembers where the first visible element sits inside the scroll
 * content. When a layout change moves it, scrollTop moves by the same amount,
 * so what the user is reading stays put. The pane disables native anchoring
 * (`overflow-anchor: none`) so the two never correct the same shift twice, and
 * this is the only code that compensates prepends — see
 * `isTranscriptScrollAnchorSupported`.
 */

/**
 * Rows the anchor is chosen from: the transcript's row wrappers, minus lazy
 * placeholders whose height is still a guess — they snap to their real height
 * when they mount, moving everything below them.
 */
const ROW_SELECTOR = ':scope > [data-message-timestamp]:not([data-estimated-height])';

/** Shifts smaller than this are layout rounding, not movement. */
const EPSILON_PX = 0.5;

/**
 * How close to its old on-screen spot an anchor must be to count as already
 * in place. Browsers round scrollTop to whole (device) pixels.
 */
const IN_PLACE_TOLERANCE_PX = 1.5;

/** How close to the end counts as "at the bottom" (scrollTop is rounded). */
const AT_BOTTOM_TOLERANCE_PX = 2;

/** How many elements of a row cut by the top edge are searched for an anchor. */
const MAX_DESCENDANTS_SEARCHED = 400;

/**
 * Rows after the anchor kept as fallbacks: a row whose key changes (a tool
 * group absorbing calls from a prepended page) is replaced by a new element,
 * and the next row down still knows where the content was.
 */
const FALLBACK_ROWS = 3;

/** True where the transcript anchors its own scroll position (any real browser). */
export function isTranscriptScrollAnchorSupported(): boolean {
  return typeof ResizeObserver !== 'undefined';
}

export type ScrollAnchor = {
  /** After a layout change: corrects any shift of the anchor, then re-picks it. */
  settle: () => void;
  /**
   * After a scroll: the same, except it never pulls the view back to the
   * bottom — the user may be scrolling up out of a streaming reply.
   */
  settleAfterScroll: () => void;
  /** Re-picks the anchor at the current position without correcting anything. */
  rebase: () => void;
  /** Anchors on a clicked element until the next settle. */
  holdClicked: (target: EventTarget | null) => void;
};

type AnchorCandidate = {
  element: Element;
  /** The element the user just clicked; it outranks staying at the bottom. */
  clicked: boolean;
  /** Top inside the scroll content — unaffected by scrolling. */
  contentTop: number;
  /** Top relative to the container's top edge. */
  viewportTop: number;
};

/** The first element inside `row` that starts at or below the viewport's top edge. */
function firstVisibleDescendant(row: Element, containerTop: number): Element | null {
  const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_ELEMENT);
  for (let searched = 0; searched < MAX_DESCENDANTS_SEARCHED; searched += 1) {
    const element = walker.nextNode() as Element | null;
    if (!element) return null;
    const box = element.getBoundingClientRect();
    if (box.height > 0 && box.top >= containerTop) return element;
  }
  return null;
}

export function createScrollAnchor(container: HTMLElement, content: HTMLElement): ScrollAnchor {
  let candidates: AnchorCandidate[] = [];
  /** Whether the user was at the very bottom when the anchor was picked. */
  let wasAtBottom = false;
  /** Scroll geometry when the anchor was picked: a change means layout moved, not the user. */
  let pickedScrollHeight = 0;
  let pickedClientHeight = 0;

  const measure = (element: Element, clicked = false): AnchorCandidate => {
    const viewportTop = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    return { element, clicked, viewportTop, contentTop: viewportTop + container.scrollTop };
  };

  const distanceFromBottom = () => container.scrollHeight - container.scrollTop - container.clientHeight;

  const pick = () => {
    candidates = [];
    wasAtBottom = distanceFromBottom() <= AT_BOTTOM_TOLERANCE_PX;
    pickedScrollHeight = container.scrollHeight;
    pickedClientHeight = container.clientHeight;

    const rows = content.querySelectorAll(ROW_SELECTOR);
    if (rows.length === 0) return;

    // Rows are in document order, so the first one whose bottom edge is below
    // the container's top edge can be found by bisection — "Load all" can put
    // thousands of rows here.
    const containerBox = container.getBoundingClientRect();
    let low = 0;
    let high = rows.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (rows[middle].getBoundingClientRect().bottom > containerBox.top) {
        found = middle;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }
    if (found < 0) return;

    // The first row that starts on screen is the anchor. A row cut by the top
    // edge is not: its own top stays put while its content changes (a lazy
    // row mounting over its placeholder) and everything under it moves. Only
    // when one row fills the whole viewport is a visible element inside it
    // used instead.
    //
    // Nor is the oldest loaded row while it is not the only one on screen: it
    // changes with whatever loads above it — its "Claude" header goes away
    // once an older reply precedes it, a tool group swallows older calls.
    if (found === 0 && rows.length > 1 && rows[1].getBoundingClientRect().top < containerBox.bottom) {
      found = 1;
    }
    const elements: Element[] = [];
    const first = rows[found];
    if (first.getBoundingClientRect().top >= containerBox.top) {
      elements.push(first);
    } else {
      const next = rows[found + 1];
      if (!next || next.getBoundingClientRect().top >= containerBox.bottom) {
        const visiblePart = firstVisibleDescendant(first, containerBox.top);
        if (visiblePart) elements.push(visiblePart);
      }
    }
    for (let index = found + 1; index < rows.length && index <= found + FALLBACK_ROWS; index += 1) {
      elements.push(rows[index]);
    }
    if (elements.length === 0) elements.push(first);
    candidates = elements.map((element) => measure(element));
  };

  // What the user clicked inside a row stays still until the next settle, so
  // expanding a tool call grows downward from the click instead of shoving the
  // clicked control up — also at the bottom, where the view would otherwise
  // follow the new end of the transcript.
  const holdClicked = (target: EventTarget | null) => {
    if (!(target instanceof Element) || !content.contains(target)) return;
    if (!target.closest('[data-message-timestamp]')) return;
    candidates = [
      measure(target, true),
      ...candidates.map((candidate) => measure(candidate.element)),
    ];
  };

  const correct = (mayPinToBottom: boolean) => {
    const previous = candidates.find((candidate) => candidate.element.isConnected);
    const layoutChanged = container.scrollHeight !== pickedScrollHeight
      || container.clientHeight !== pickedClientHeight;

    if (mayPinToBottom && wasAtBottom && layoutChanged && !previous?.clicked) {
      // At the newest message it stays in view as content settles or streams
      // in below; the initial scroll to the bottom gives up after a second,
      // before late markdown and tool output have their final height.
      if (distanceFromBottom() > AT_BOTTOM_TOLERANCE_PX) {
        container.scrollTop = container.scrollHeight;
      }
    } else if (previous) {
      const now = measure(previous.element);
      const shift = now.contentTop - previous.contentTop;
      // Already in place on screen: the browser clamped scrollTop by exactly
      // the shift (content shrinking while scrolled to the bottom).
      const inPlace = Math.abs(now.viewportTop - previous.viewportTop) < IN_PLACE_TOLERANCE_PX;
      if (Math.abs(shift) >= EPSILON_PX && !inPlace) {
        container.scrollTop += shift;
      }
    }
    pick();
  };

  return {
    settle: () => correct(true),
    settleAfterScroll: () => correct(false),
    rebase: pick,
    holdClicked,
  };
}

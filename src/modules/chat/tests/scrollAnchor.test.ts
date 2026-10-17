import { describe, expect, it } from 'vitest';

import { createScrollAnchor } from '@/modules/chat/utils/scrollAnchor';

/**
 * jsdom has no layout, so this lays the transcript out the way a browser
 * without native scroll anchoring (Safari) does: rows stacked in a scroll
 * container whose scrollTop only changes when someone writes it, clamped to
 * the scrollable range. Every rect the anchor reads comes from this model.
 */
function createTranscript(rowHeights: number[], clientHeight = 600) {
  const container = document.createElement('div');
  const content = document.createElement('div');
  container.appendChild(content);
  document.body.appendChild(container);

  const heights = new Map<Element, number>();
  let scrollTop = 0;

  const rowsInOrder = () => Array.from(content.children);
  const scrollHeight = () => rowsInOrder().reduce((sum, row) => sum + (heights.get(row) ?? 0), 0);
  const maxScrollTop = () => Math.max(0, scrollHeight() - clientHeight);

  const topOf = (element: Element): number => {
    let top = -scrollTop;
    for (const row of rowsInOrder()) {
      if (row === element) return top;
      if (row.contains(element)) return top + Number((element as HTMLElement).dataset.offset ?? 0);
      top += heights.get(row) ?? 0;
    }
    throw new Error('element is not in the transcript');
  };

  const box = (top: number, height: number) => ({
    top, bottom: top + height, height, left: 0, right: 400, width: 400, x: 0, y: top, toJSON: () => ({}),
  }) as DOMRect;

  container.getBoundingClientRect = () => box(0, clientHeight);
  Object.defineProperty(container, 'clientHeight', { get: () => clientHeight });
  Object.defineProperty(container, 'scrollHeight', { get: () => scrollHeight() });
  Object.defineProperty(container, 'scrollTop', {
    get: () => scrollTop,
    set: (next: number) => { scrollTop = Math.min(Math.max(0, Math.round(next)), maxScrollTop()); },
  });

  const makeRow = (height: number, options: { estimated?: boolean } = {}) => {
    const row = document.createElement('div');
    row.setAttribute('data-message-timestamp', `t-${Math.random()}`);
    if (options.estimated) row.setAttribute('data-estimated-height', '');
    heights.set(row, height);
    row.getBoundingClientRect = () => box(topOf(row), heights.get(row) ?? 0);
    return row;
  };

  rowHeights.forEach((height) => content.appendChild(makeRow(height)));

  return {
    container,
    content,
    rows: rowsInOrder,
    get scrollTop() { return scrollTop; },
    set scrollTop(next: number) { container.scrollTop = next; },
    distanceFromBottom: () => scrollHeight() - scrollTop - clientHeight,
    setHeight: (row: Element, height: number) => heights.set(row, height),
    prepend: (height: number, options?: { estimated?: boolean }) => {
      const row = makeRow(height, options);
      content.insertBefore(row, content.firstChild);
      return row;
    },
    /** A child of `row` sitting `offset` px below the row's top. */
    child: (row: Element, offset: number, height = 20) => {
      const element = document.createElement('button');
      element.dataset.offset = String(offset);
      element.getBoundingClientRect = () => box(topOf(element), height);
      row.appendChild(element);
      return element;
    },
  };
}

/** Where `element` sits on screen, relative to the container's top edge. */
const screenTop = (element: Element) => element.getBoundingClientRect().top;

describe('createScrollAnchor', () => {
  it('keeps the visible message still when a row above it grows', () => {
    const transcript = createTranscript(Array(30).fill(100));
    transcript.scrollTop = 1050;
    const anchor = createScrollAnchor(transcript.container, transcript.content);
    anchor.rebase();
    const reading = transcript.rows()[12];
    const before = screenTop(reading);

    // A lazy row far above mounts over its 100px placeholder at 340px.
    transcript.setHeight(transcript.rows()[3], 340);
    anchor.settle();

    expect(screenTop(reading)).toBe(before);
  });

  it('keeps the visible message still when an older page is prepended', () => {
    const transcript = createTranscript(Array(20).fill(100));
    transcript.scrollTop = 40;
    const anchor = createScrollAnchor(transcript.container, transcript.content);
    anchor.rebase();
    const reading = transcript.rows()[3];
    const before = screenTop(reading);

    for (let index = 0; index < 20; index += 1) transcript.prepend(80);
    anchor.settle();

    expect(screenTop(reading)).toBe(before);
  });

  it('does not anchor on the oldest loaded row, whose header goes away once older messages load', () => {
    const transcript = createTranscript(Array(20).fill(100));
    transcript.scrollTop = 0;
    const anchor = createScrollAnchor(transcript.container, transcript.content);
    anchor.rebase();
    const oldest = transcript.rows()[0];
    const below = transcript.rows()[1];
    const before = screenTop(below);

    // The page lands and the formerly oldest message loses its 60px header.
    for (let index = 0; index < 20; index += 1) transcript.prepend(80);
    transcript.setHeight(oldest, 40);
    anchor.settle();

    expect(screenTop(below)).toBe(before);
  });

  it('never anchors on a placeholder whose height is still a guess', () => {
    const transcript = createTranscript(Array(20).fill(100));
    const guessed = transcript.rows()[5];
    guessed.setAttribute('data-estimated-height', '');
    transcript.scrollTop = 500; // the guessed row starts exactly at the top edge
    const anchor = createScrollAnchor(transcript.container, transcript.content);
    anchor.rebase();
    const below = transcript.rows()[6];
    const before = screenTop(below);

    // Mounting, the guessed row turns out shorter. Had it been the anchor (its
    // own top does not move), everything below it would jump up uncorrected.
    transcript.setHeight(guessed, 30);
    anchor.settle();

    expect(screenTop(below)).toBe(before);
  });

  it('stays at the bottom while content below grows (streaming)', () => {
    const transcript = createTranscript(Array(20).fill(100));
    transcript.scrollTop = 99_999;
    const anchor = createScrollAnchor(transcript.container, transcript.content);
    anchor.rebase();

    transcript.setHeight(transcript.rows()[19], 400);
    anchor.settle();

    expect(transcript.distanceFromBottom()).toBe(0);
  });

  it('does not pull a user who scrolls up out of a streaming reply back down', () => {
    const transcript = createTranscript(Array(20).fill(100));
    transcript.scrollTop = 99_999;
    const anchor = createScrollAnchor(transcript.container, transcript.content);
    anchor.rebase();

    // The reply grows in the same frame as the user's scroll up; the scroll
    // event is dispatched before the resize notification.
    transcript.setHeight(transcript.rows()[19], 250);
    transcript.scrollTop -= 300;
    anchor.settleAfterScroll();
    const afterScroll = transcript.scrollTop;
    transcript.setHeight(transcript.rows()[19], 500);
    anchor.settle();

    expect(transcript.scrollTop).toBe(afterScroll);
    expect(transcript.distanceFromBottom()).toBeGreaterThan(0);
  });

  it('keeps a clicked control still when its row expands, even at the bottom', () => {
    const transcript = createTranscript(Array(20).fill(100));
    transcript.scrollTop = 99_999;
    const anchor = createScrollAnchor(transcript.container, transcript.content);
    anchor.rebase();
    const row = transcript.rows()[18];
    const toggle = transcript.child(row, 10);
    const before = screenTop(toggle);

    anchor.holdClicked(toggle);
    transcript.setHeight(row, 700);
    anchor.settle();

    expect(screenTop(toggle)).toBe(before);
  });

  it('ignores a user scroll: nothing is corrected when only scrollTop changed', () => {
    const transcript = createTranscript(Array(20).fill(100));
    transcript.scrollTop = 500;
    const anchor = createScrollAnchor(transcript.container, transcript.content);
    anchor.rebase();

    transcript.scrollTop = 320;
    anchor.settleAfterScroll();

    expect(transcript.scrollTop).toBe(320);
  });
});

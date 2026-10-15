import { useCallback, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';

/** What the platform calls the toggle-select modifier, for hints: ⌘ on Apple devices, Ctrl elsewhere. */
const MODIFIER_LABEL = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

export type MultiSelect<K> = {
  selected: ReadonlySet<K>;
  /** Selection is on: rows show checkboxes and a plain click toggles instead of opening. */
  isSelecting: boolean;
  /** "⌘" or "Ctrl", for the hint next to the menu entry. */
  modifierLabel: string;
  /**
   * Handles a click on a row: ⌘/Ctrl toggles it, Shift adds the range from
   * the last toggled row, and while selecting a plain click toggles too.
   * Otherwise it calls `open`.
   */
  handleClick: (key: K, event: MouseEvent, open: () => void) => void;
  toggle: (key: K) => void;
  /** Turns on selection without picking anything — the touch-screen way in, from a menu. */
  startSelecting: () => void;
  selectAll: () => void;
  clear: () => void;
};

/**
 * Used by the channels Inbox and the agent-tasks boards: desktop-style
 * multi-select over an ordered list (⌘/Ctrl-click, Shift-click ranges) plus
 * an explicit selection mode for touch screens, where there is no modifier.
 * Keys that leave the list drop out of the selection.
 */
export function useMultiSelect<K>(orderedKeys: readonly K[]): MultiSelect<K> {
  // The picked rows as clicked; read through `selected`, which drops rows no longer listed.
  const [picked, setSelected] = useState<ReadonlySet<K>>(() => new Set());
  // Selection mode entered from a menu with nothing picked yet (touch screens).
  const [selectMode, setSelectMode] = useState(false);
  // The row a Shift-click range starts from: the last one toggled.
  const [anchor, setAnchor] = useState<K | null>(null);

  // A refetch can drop rows (deleted elsewhere); they must not count as selected.
  const selected = useMemo<ReadonlySet<K>>(() => {
    const present = new Set(orderedKeys);
    const kept = new Set([...picked].filter((key) => present.has(key)));
    return kept.size === picked.size ? picked : kept;
  }, [picked, orderedKeys]);

  const toggle = useCallback((key: K) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setAnchor(key);
  }, []);

  const isSelecting = selectMode || selected.size > 0;

  const handleClick = useCallback((key: K, event: MouseEvent, open: () => void) => {
    if (event.shiftKey && anchor !== null) {
      event.preventDefault();
      const from = orderedKeys.indexOf(anchor);
      const to = orderedKeys.indexOf(key);
      if (from !== -1 && to !== -1) {
        const range = orderedKeys.slice(Math.min(from, to), Math.max(from, to) + 1);
        setSelected((previous) => new Set([...previous, ...range]));
        return;
      }
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || isSelecting) {
      event.preventDefault();
      toggle(key);
      return;
    }
    open();
  }, [anchor, isSelecting, orderedKeys, toggle]);

  const clear = useCallback(() => {
    setSelected(new Set());
    setSelectMode(false);
    setAnchor(null);
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(orderedKeys));
    setSelectMode(true);
  }, [orderedKeys]);

  const startSelecting = useCallback(() => setSelectMode(true), []);

  return useMemo(() => ({
    selected,
    isSelecting,
    modifierLabel: MODIFIER_LABEL,
    handleClick,
    toggle,
    startSelecting,
    selectAll,
    clear,
  }), [selected, isSelecting, handleClick, toggle, startSelecting, selectAll, clear]);
}

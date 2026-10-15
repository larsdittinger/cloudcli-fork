/**
 * Marks an open popover that closes on Escape. ChatInterface's Escape-to-stop
 * shortcut listens on the whole document in the capture phase, so it hears the
 * key before the popover does and cannot rely on the popover consuming it.
 */
export const CLAIMS_ESCAPE_ATTRIBUTE = 'data-claims-escape';

/**
 * Whether an Escape press belongs to something open over the chat — a modal
 * dialog or a marked popover — rather than to the stop shortcut. Stopping
 * interrupts the CLI, which kills every background agent of the session, so a
 * key meant to close a window must never reach it.
 */
export function isEscapeClaimedElsewhere(): boolean {
  return document.querySelector(`[aria-modal="true"], [${CLAIMS_ESCAPE_ATTRIBUTE}]`) !== null;
}

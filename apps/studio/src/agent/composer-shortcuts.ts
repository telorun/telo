const APPLE = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** How the platform's command modifier is written on a button or in a hint. */
export const MOD_KEY_LABEL = APPLE ? "⌘" : "Ctrl+";

/** Opens the agent panel and focuses its composer. Not Cmd/Ctrl+K: that is the
 *  prefix of Monaco's chords (Ctrl+K Ctrl+C, Ctrl+K Ctrl+I, …), and taking it
 *  would break every one of them in the source view. */
export const FOCUS_COMPOSER_LABEL = `${MOD_KEY_LABEL}J`;

export function isFocusComposerShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "j";
}

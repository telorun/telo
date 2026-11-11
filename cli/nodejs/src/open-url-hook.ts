import { openBrowser } from "./open-browser.js";
import { personIsAtTerminal, type TerminalStreams } from "./person-at-terminal.js";

export interface OpenUrlHookOptions extends TerminalStreams {
  open?: (url: string) => void;
  /** Reports every call, undeduplicated, to the debug stream. */
  emit?: (url: string) => void;
}

/**
 * The hook behind `Telo.OpenUrl`, one per `telo run` session — a `--watch`
 * reload builds a new kernel and hands it this same function, which is where
 * "a URL is opened at most once" is remembered.
 *
 * The browser opener exists only where a person is at the terminal (stdin and
 * stderr are TTYs, no `--no-input`); it opens at once, asks nothing and never
 * touches stdin. Under `--inspect` / `--debug` the hook also reports every call
 * through `emit`, whether or not a person is there. With neither, no hook.
 */
export function createOpenUrlHook(options: OpenUrlHookOptions): ((url: string) => void) | undefined {
  const atTerminal = personIsAtTerminal(options);
  const { emit } = options;
  if (!atTerminal && !emit) return undefined;
  const open = options.open ?? ((url: string) => openBrowser(url));
  const opened = new Set<string>();
  return (url) => {
    emit?.(url);
    if (!atTerminal || opened.has(url)) return;
    opened.add(url);
    open(url);
  };
}

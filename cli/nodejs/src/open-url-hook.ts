import { openBrowser } from "./open-browser.js";
import { personIsAtTerminal, type TerminalStreams } from "./person-at-terminal.js";

export interface OpenUrlHookOptions extends TerminalStreams {
  open?: (url: string) => void;
}

/**
 * The hook behind `Telo.OpenUrl`, one per `telo run` session — a `--watch`
 * reload builds a new kernel and hands it this same function, which is where
 * "a URL is opened at most once" is remembered.
 *
 * Installed only where a person is at the terminal (stdin and stderr are TTYs,
 * no `--no-input`); every other host gets none and the log record carries the
 * URL. It opens at once, asks nothing and never touches stdin: after startup
 * the application owns it.
 */
export function createOpenUrlHook(options: OpenUrlHookOptions): ((url: string) => void) | undefined {
  if (!personIsAtTerminal(options)) return undefined;
  const open = options.open ?? ((url: string) => openBrowser(url));
  const opened = new Set<string>();
  return (url) => {
    if (opened.has(url)) return;
    opened.add(url);
    open(url);
  };
}

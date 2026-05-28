import { useEffect, useRef } from "react";

import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import type { TerminalBuffer } from "../terminal-buffer";

interface TerminalViewProps {
  terminal: TerminalBuffer;
  /** True once the run has reached a terminal status. The terminal stays
   *  visible (so the user can scroll the final output) but input is detached. */
  inputDisabled: boolean;
}

/** xterm.js host for a run's PTY byte transcript. Mounts the terminal
 *  imperatively and adapts the React component lifecycle around it. Attaches
 *  to the run's TerminalBuffer, which replays the recorded transcript and then
 *  streams live bytes — so re-mounting or selecting a past run re-renders its
 *  output without re-opening the (single-shot) transport. xterm owns
 *  rendering, scrollback, selection, and ANSI parsing. */
export function TerminalView({ terminal, inputDisabled }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const dataDisposerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
      fontSize: 13,
      scrollback: 5000,
      convertEol: false,
      theme: {
        background: "#09090b",
        foreground: "#e4e4e7",
        cursor: "#fbbf24",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());

    term.open(host);
    // Canvas renderer is a meaningful perf win for large scrollback writes
    // (chat-console's streaming completions). It must be loaded after
    // `term.open(host)` because it draws onto the terminal's backing
    // element. If the platform refuses to give us a 2D context (rare —
    // headless test envs, very old GPUs), fall back to the DOM renderer
    // silently rather than failing the whole mount.
    try {
      term.loadAddon(new CanvasAddon());
    } catch {
      /* DOM renderer remains active */
    }
    fit.fit();

    const encoder = new TextEncoder();

    // Replays the recorded transcript into this fresh xterm, then streams live
    // bytes. xterm accepts Uint8Array directly and handles UTF-8 framing
    // internally — partial sequences across chunks are fine.
    const detach = terminal.attach((bytes) => term.write(bytes));
    termRef.current = term;

    const sub = term.onData((s) => {
      terminal.send(encoder.encode(s));
    });
    dataDisposerRef.current = () => sub.dispose();

    // Forward both initial size and subsequent layout changes. ResizeObserver
    // fires once on attach with current dimensions, which doubles as the
    // initial resize signal.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // fit() throws if the host is detached / 0-sized; the next observer
        // tick will retry.
        return;
      }
      terminal.resize(term.cols, term.rows);
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      dataDisposerRef.current?.();
      dataDisposerRef.current = null;
      // Detach only — the buffer (and its transport) outlives the view so the
      // transcript stays replayable for history. Teardown happens on eviction.
      detach();
      term.dispose();
      termRef.current = null;
    };
  }, [terminal]);

  // When the run reaches terminal status, drop the keystroke listener but
  // keep the terminal mounted so the user can scroll the final transcript.
  useEffect(() => {
    if (!inputDisabled) return;
    dataDisposerRef.current?.();
    dataDisposerRef.current = null;
  }, [inputDisabled]);

  return <div ref={containerRef} className="h-full w-full bg-zinc-950" />;
}

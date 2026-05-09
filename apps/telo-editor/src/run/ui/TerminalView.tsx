import { useEffect, useRef } from "react";

import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import type { RunIo, RunIoConnection } from "../types";

interface TerminalViewProps {
  io: RunIo;
  /** True once the run has reached a terminal status. The terminal stays
   *  visible (so the user can scroll the final output) but input is detached. */
  inputDisabled: boolean;
}

/** xterm.js host for the live PTY byte stream of a run session. Mounts the
 *  terminal imperatively and adapts the React component lifecycle around it.
 *  The component is deliberately framework-agnostic on the inside — xterm
 *  owns rendering, scrollback, selection, and ANSI parsing. */
export function TerminalView({ io, inputDisabled }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const connectionRef = useRef<RunIoConnection | null>(null);
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

    const conn = io.open({
      onData(bytes) {
        // xterm accepts Uint8Array directly and handles UTF-8 framing
        // internally — partial sequences across chunks are fine.
        term.write(bytes);
      },
      onClose() {
        // Detach the keystroke listener so further user input drops on the
        // floor rather than reaching a closed transport.
        dataDisposerRef.current?.();
        dataDisposerRef.current = null;
      },
    });
    connectionRef.current = conn;
    termRef.current = term;

    const sub = term.onData((s) => {
      conn.send(encoder.encode(s));
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
      conn.resize(term.cols, term.rows);
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      dataDisposerRef.current?.();
      dataDisposerRef.current = null;
      try {
        conn.close();
      } catch {
        /* already closed */
      }
      connectionRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [io]);

  // When the run reaches terminal status, drop the keystroke listener but
  // keep the terminal mounted so the user can scroll the final transcript.
  useEffect(() => {
    if (!inputDisabled) return;
    dataDisposerRef.current?.();
    dataDisposerRef.current = null;
  }, [inputDisabled]);

  return <div ref={containerRef} className="h-full w-full bg-zinc-950" />;
}

import type { DebugFrame } from "@telorun/debug-wire";
import { DebugPanel } from "@telorun/debug-ui/components";
import { Bug } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { useColorMode } from "../../theme/color-mode";
import { useRun } from "../context";
import type { RunRecord } from "../context";
import type { TerminalBuffer } from "../terminal-buffer";
import { isTerminal } from "../types";
import { AdapterUnavailable } from "./AdapterUnavailable";
import { LogStream } from "./LogStream";
import { RunStatusChip } from "./RunStatusChip";
import { TerminalView } from "./TerminalView";

/** Full-canvas output viewer for the selected run (or an unavailable/
 *  setup-required message). Renders in place of the normal view multiplexer;
 *  closing it returns to the previous view. The run shown is driven by the
 *  RunContext's `selectedRun` — a freshly started run or one picked from the
 *  Run-button history dropdown. */
export function RunView() {
  const { selectedRun, unavailableRun, isStarting, removeRun, closeRunView, getTerminal } = useRun();

  if (unavailableRun) {
    return (
      <AdapterUnavailable
        adapterDisplayName={unavailableRun.adapterDisplayName}
        message={unavailableRun.message}
        remediation={unavailableRun.remediation}
        action={unavailableRun.action}
        onRecheck={unavailableRun.recheck}
        onClose={closeRunView}
      />
    );
  }

  if (isStarting) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-zinc-500 dark:text-zinc-400">
        <span
          className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden
        />
        <span>Starting run…</span>
      </div>
    );
  }

  if (!selectedRun) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-zinc-500 dark:text-zinc-400">
        <span className="text-zinc-400 dark:text-zinc-600">No run selected.</span>
      </div>
    );
  }

  const terminal = selectedRun.hasTerminal ? getTerminal(selectedRun.id) : null;

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-3 dark:border-zinc-800 dark:bg-zinc-950">
        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
          {selectedRun.adapterDisplayName}
        </span>
        <RunStatusChip status={selectedRun.status} />
        {selectedRun.status.kind === "running" && selectedRun.status.inspectUrl && (
          <a
            href={selectedRun.status.inspectUrl}
            target="_blank"
            rel="noreferrer"
            title="Open inspection UI"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <Bug size={13} aria-hidden />
            Inspect
          </a>
        )}
        {selectedRun.status.kind === "starting" && selectedRun.progress && (
          <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {selectedRun.progress.message}
          </span>
        )}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={closeRunView}>
          ×
        </Button>
      </div>
      {selectedRun.status.kind === "failed" && (
        <div className="flex shrink-0 items-start gap-2 border-b border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <span className="font-medium">Run failed:</span>
          <span className="flex-1 break-words font-mono">{selectedRun.status.message}</span>
        </div>
      )}
      {selectedRun.historyUnavailable && (
        <div className="flex shrink-0 items-center gap-3 border-b border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <span className="flex-1">
            This run's history is no longer available on the runner — it expired or
            the runner restarted.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              removeRun(selectedRun.id);
              closeRunView();
            }}
          >
            Remove from history
          </Button>
        </div>
      )}
      <RunDebugPanel run={selectedRun} terminal={terminal} />
    </div>
  );
}

/** The run view is the shared debug-ui panel: its Logs tab hosts the run's own
 *  interactive terminal (xterm + stdin) — or, for log-only adapters, the read-only
 *  LogStream — and its Events tab shows the relayed kernel events. Pause freezes
 *  the events view against a snapshot; clear hides frames seen so far. (Blob
 *  payloads aren't resolvable in the embed yet — the workload's blob endpoint
 *  isn't reachable from the editor; events + logs work.) */
function RunDebugPanel({ run, terminal }: { run: RunRecord; terminal: TerminalBuffer | null }) {
  const [paused, setPaused] = useState(false);
  // The sequence of the most recent Clear, not an index — `debugFrames` is a ring
  // buffer, so absolute indices drift as old frames evict. Frames with sequence
  // `>= clearedSeq` are shown.
  const [clearedSeq, setClearedSeq] = useState(0);
  const snapshot = useRef<DebugFrame[]>([]);
  const colorMode = useColorMode();

  const status: "connecting" | "open" | "closed" =
    run.status.kind === "running" ? "open" : isTerminal(run.status) ? "closed" : "connecting";
  const endpoints = run.status.kind === "running" ? run.status.endpoints : undefined;

  // Map the cleared sequence to an offset into the current (possibly-evicted)
  // window. `firstSeq` is the sequence of `debugFrames[0]`; clamp to 0 so a
  // boundary that has already scrolled out of the window shows everything kept.
  const firstSeq = run.debugFrameSeq - run.debugFrames.length;
  const offset = Math.max(0, clearedSeq - firstSeq);
  const liveFrames = offset > 0 ? run.debugFrames.slice(offset) : run.debugFrames;
  if (!paused) snapshot.current = liveFrames;
  const frames = paused ? snapshot.current : liveFrames;

  const logsSlot = terminal ? (
    <TerminalView key={run.id} terminal={terminal} inputDisabled={isTerminal(run.status)} />
  ) : (
    <LogStream lines={run.lines} truncated={run.truncated} />
  );

  return (
    <DebugPanel
      frames={frames}
      revision={frames.length}
      status={status}
      paused={paused}
      onTogglePause={() => setPaused((p) => !p)}
      onClear={() => setClearedSeq(run.debugFrameSeq)}
      resolveBlobUrl={(rel: string) => rel}
      logsSlot={logsSlot}
      defaultTab="logs"
      endpoints={endpoints}
      endpointReachability={run.portReachability}
      theme={colorMode}
    />
  );
}


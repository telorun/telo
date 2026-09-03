import type { DebugFrame } from "@telorun/debug-wire";
import { DebugPanel } from "@telorun/debug-ui/components";
import { useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { useColorMode } from "../../theme/color-mode";
import { useRun } from "../context";
import type { RunBlocker, RunRecord } from "../context";
import type { TerminalBuffer } from "../terminal-buffer";
import { isTerminal } from "../types";
import { AdapterUnavailable } from "./AdapterUnavailable";
import { LogStream } from "./LogStream";
import { MissingConfigNotice } from "./MissingConfigNotice";
import { TerminalView } from "./TerminalView";

interface RunOutputProps {
  /** The Application whose dock this body fills. */
  appPath: string;
  /** Open the app's Variables tab — where every blocker's fix lives. */
  onOpenConfig: () => void;
}

/** Body of one Application's run dock: the selected run's output, or why no run
 *  started. The status header, resize and collapse live in the dock frame — this
 *  renders what happened, never the chrome around it. */
export function RunOutput({ appPath, onOpenConfig }: RunOutputProps) {
  const { selectedRunForApp, blockerForApp, isStartingApp, clearBlocker, removeRun, getTerminal } =
    useRun();

  const blocker = blockerForApp(appPath);
  if (blocker) {
    return (
      <RunBlockerBody
        blocker={blocker}
        onDismiss={() => clearBlocker(appPath)}
        onOpenConfig={onOpenConfig}
      />
    );
  }

  if (isStartingApp(appPath)) {
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

  const selectedRun = selectedRunForApp(appPath);
  if (!selectedRun) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-zinc-500 dark:text-zinc-400">
        <span className="text-zinc-400 dark:text-zinc-600">This application hasn't run yet.</span>
      </div>
    );
  }

  const terminal = selectedRun.hasTerminal ? getTerminal(selectedRun.id) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {selectedRun.status.kind === "failed" && (
        <div className="flex shrink-0 items-start gap-2 border-b border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <span className="font-medium">Run failed:</span>
          <span className="flex-1 break-words font-mono">{selectedRun.status.message}</span>
        </div>
      )}
      {selectedRun.unroutablePorts.size > 0 && (
        <div className="flex shrink-0 flex-col gap-1 border-b border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          {[...selectedRun.unroutablePorts].map(([port, reason]) => (
            <div key={port} className="flex items-start gap-2">
              <span className="font-medium">Port {port} is not reachable:</span>
              <span className="flex-1 break-words">{reason}</span>
            </div>
          ))}
        </div>
      )}
      {selectedRun.historyUnavailable && (
        <div className="flex shrink-0 items-center gap-3 border-b border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <span className="flex-1">
            This run's history is no longer available on the runner — it expired or the runner
            restarted.
          </span>
          <Button size="sm" variant="outline" onClick={() => removeRun(selectedRun.id)}>
            Remove from history
          </Button>
        </div>
      )}
      <RunDebugPanel run={selectedRun} terminal={terminal} />
    </div>
  );
}

function RunBlockerBody({
  blocker,
  onDismiss,
  onOpenConfig,
}: {
  blocker: RunBlocker;
  onDismiss: () => void;
  onOpenConfig: () => void;
}) {
  if (blocker.kind === "missing-config") {
    return (
      <MissingConfigNotice
        entries={blocker.entries}
        onOpenConfig={onOpenConfig}
        onDismiss={onDismiss}
      />
    );
  }
  return (
    <AdapterUnavailable
      adapterDisplayName={blocker.adapterDisplayName}
      message={blocker.message}
      remediation={blocker.remediation}
      action={blocker.action}
      onRecheck={blocker.recheck}
      onClose={onDismiss}
    />
  );
}

/** The run body is the shared debug-ui panel: its Logs tab hosts the run's own
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

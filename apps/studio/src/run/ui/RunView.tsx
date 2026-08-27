import type { DebugFrame } from "@telorun/debug-wire";
import { DebugPanel } from "@telorun/debug-ui/components";
import { Bug, Play, RotateCw } from "lucide-react";
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
        <RunGenerations runs={selectedRun.runs} />
        <div className="flex-1" />
        <WatchControls run={selectedRun} />
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

/**
 * The latest run outcome per application — deliberately separate from the
 * session status chip beside it. A one-shot app completing in a watch session
 * leaves the session `running`, so "the session is up" and "the last run
 * succeeded" are two different facts and are shown as two.
 */
function RunGenerations({ runs }: { runs: RunRecord["runs"] }) {
  const entries = Object.values(runs);
  if (entries.length === 0) return null;
  return (
    <span className="flex items-center gap-2">
      {entries.map((run) => (
        <span
          key={run.app}
          className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-zinc-500 dark:text-zinc-400"
          title={
            run.phase === "failed"
              ? run.reason
              : run.phase === "completed"
                ? `exit ${run.code}`
                : `started by ${run.trigger}`
          }
        >
          {entries.length > 1 && (
            <span className="font-medium text-zinc-600 dark:text-zinc-300">{run.app}</span>
          )}
          <span className="tabular-nums">#{run.generation}</span>
          <span
            className={
              run.phase === "failed"
                ? "text-red-600 dark:text-red-400"
                : run.phase === "completed"
                  ? run.code === 0
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-600 dark:text-red-400"
                  : "text-blue-600 dark:text-blue-400"
            }
          >
            {run.phase === "started"
              ? run.trigger === "watch"
                ? "reloading"
                : "running"
              : run.phase === "completed"
                ? `exit ${run.code}`
                : "failed"}
          </span>
        </span>
      ))}
    </span>
  );
}

/** Reload and Resume — the two things a watch session can do that a run session
 *  cannot. Both are absent on a run session, where the session IS the run. */
function WatchControls({ run }: { run: RunRecord }) {
  const { reloadRun, resumeRun } = useRun();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const act = (work: Promise<void>): void => {
    setBusy(true);
    setProblem(null);
    void work
      .catch((err: unknown) => setProblem(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const note = problem ? (
    <span className="max-w-64 truncate text-[11px] text-red-600 dark:text-red-400" title={problem}>
      {problem}
    </span>
  ) : null;

  if (run.status.kind === "suspended") {
    return (
      <>
        {note}
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          title="The session was reaped for idleness; its workspace checkpoint is held"
          onClick={() =>
            act(
              resumeRun(run.id).then((resumed) => {
                // The checkpoint lives in the runner's memory, so a restart loses
                // it. Saying so is the whole remedy the design relies on: the
                // editor holds the authoritative workspace and re-runs to re-seed.
                if (!resumed) {
                  throw new Error(
                    "The runner no longer holds this session — run it again to start a fresh one.",
                  );
                }
              }),
            )
          }
        >
          <Play size={13} aria-hidden />
          Resume
        </Button>
      </>
    );
  }

  // `runs` is populated only by a session that reports run outcomes — a watch
  // session. A run session never shows these.
  if (run.status.kind !== "running" || Object.keys(run.runs).length === 0) return null;

  return (
    <>
      {note}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        title="Re-run with no file change"
        onClick={() => act(reloadRun(run.id))}
      >
        <RotateCw size={13} aria-hidden />
        Reload
      </Button>
    </>
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


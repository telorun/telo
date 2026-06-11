import { Button } from "../../components/ui/button";
import { useRun } from "../context";
import { isTerminal, type RunnerEndpoint } from "../types";
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
  const {
    selectedRun,
    unavailableRun,
    isStarting,
    stopRun,
    closeRunView,
    getTerminal,
  } = useRun();

  if (unavailableRun) {
    return (
      <AdapterUnavailable
        adapterDisplayName={unavailableRun.adapterDisplayName}
        message={unavailableRun.message}
        remediation={unavailableRun.remediation}
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

  const isRunning =
    selectedRun.status.kind === "starting" || selectedRun.status.kind === "running";
  const terminal = selectedRun.hasTerminal ? getTerminal(selectedRun.id) : null;

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-3 dark:border-zinc-800 dark:bg-zinc-950">
        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
          {selectedRun.adapterDisplayName}
        </span>
        <RunStatusChip status={selectedRun.status} />
        {selectedRun.status.kind === "running" && (
          <EndpointChips endpoints={selectedRun.status.endpoints ?? []} />
        )}
        {selectedRun.status.kind === "starting" && selectedRun.progress && (
          <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {selectedRun.progress.message}
          </span>
        )}
        <div className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          onClick={() => void stopRun(selectedRun.id)}
          disabled={!isRunning}
        >
          Stop
        </Button>
        <Button size="sm" variant="ghost" onClick={closeRunView}>
          ×
        </Button>
      </div>
      <div className="flex flex-1 overflow-hidden">
        {terminal ? (
          <TerminalView
            key={selectedRun.id}
            terminal={terminal}
            inputDisabled={isTerminal(selectedRun.status)}
          />
        ) : (
          <LogStream lines={selectedRun.lines} truncated={selectedRun.truncated} />
        )}
      </div>
    </div>
  );
}

function EndpointChips({ endpoints }: { endpoints: RunnerEndpoint[] }) {
  if (endpoints.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5">
      {endpoints.map((endpoint) => {
        const label = `${formatHost(endpoint.host)}:${endpoint.port}`;
        if (endpoint.protocol === "tcp") {
          return (
            <a
              key={`${endpoint.host}:${endpoint.port}/${endpoint.protocol}`}
              href={`http://${label}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-[10px] text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              {label}
            </a>
          );
        }
        return (
          <span
            key={`${endpoint.host}:${endpoint.port}/${endpoint.protocol}`}
            className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-[10px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
          >
            {label}/{endpoint.protocol}
          </span>
        );
      })}
    </div>
  );
}

function formatHost(host: string): string {
  // IPv6 literals need bracketing when paired with a port.
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

import { Button } from "../../components/ui/button";
import { useRun } from "../context";
import type { RunnerEndpoint } from "../types";
import { AdapterUnavailable } from "./AdapterUnavailable";
import { LogStream } from "./LogStream";
import { RunStatusChip } from "./RunStatusChip";

/** Full-canvas replacement shown while a run is active (or an
 *  unavailable/setup-required message needs surfacing). Renders in place of
 *  the normal view multiplexer; closing it returns to the previous view. */
export function RunView() {
  const {
    activeRun,
    unavailableRun,
    isStarting,
    stopRun,
    clearLog,
    closeRunView,
  } = useRun();

  if (unavailableRun && !activeRun) {
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

  if (!activeRun) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-zinc-500 dark:text-zinc-400">
        {isStarting ? (
          <>
            <span
              className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent"
              aria-hidden
            />
            <span>Starting run…</span>
          </>
        ) : (
          <span className="text-zinc-400 dark:text-zinc-600">No active run.</span>
        )}
      </div>
    );
  }

  const isRunning =
    activeRun.status.kind === "starting" || activeRun.status.kind === "running";

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-3 dark:border-zinc-800 dark:bg-zinc-950">
        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
          {activeRun.adapterDisplayName}
        </span>
        <RunStatusChip status={activeRun.status} />
        {activeRun.status.kind === "running" && (
          <EndpointChips endpoints={activeRun.status.endpoints ?? []} />
        )}
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={stopRun} disabled={!isRunning}>
          Stop
        </Button>
        <Button size="sm" variant="ghost" onClick={clearLog} disabled={isRunning}>
          Clear
        </Button>
        <Button size="sm" variant="ghost" onClick={closeRunView}>
          ×
        </Button>
      </div>
      <div className="flex flex-1 overflow-hidden">
        <LogStream lines={activeRun.lines} truncated={activeRun.truncated} />
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

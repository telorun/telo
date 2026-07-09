import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import type { RunnerInstance } from "../../model";
import { stopLocalRunner } from "../adapters/local-docker/supervisor";
import { registry } from "../registry";
import type {
  AvailabilityAction,
  AvailabilityReport,
  ConfigIssue,
  RunAdapter,
  RunnerCapabilities,
} from "../types";
import { RunnerEditDialog } from "./RunnerEditDialog";

const HTTP_RUNNER_ADAPTER_ID = "http-runner";
const LOCAL_DOCKER_ADAPTER_ID = "local-docker";

interface RunSettingsSectionProps {
  runners: RunnerInstance[];
  activeRunnerId: string;
  onChangeRunners: (runners: RunnerInstance[]) => void;
  onChangeActiveRunner: (id: string) => void;
}

type DialogState =
  | { mode: "closed" }
  | { mode: "add" }
  | { mode: "edit"; runner: RunnerInstance };

export function RunSettingsSection({
  runners,
  activeRunnerId,
  onChangeRunners,
  onChangeActiveRunner,
}: RunSettingsSectionProps) {
  const [dialog, setDialog] = useState<DialogState>({ mode: "closed" });
  const addAdapter = registry.get(HTTP_RUNNER_ADAPTER_ID);
  // Edit resolves the adapter from the runner's own type (robust if more
  // user-addable adapter types appear); add always uses the http-runner type.
  const dialogAdapter =
    dialog.mode === "edit" ? registry.get(dialog.runner.adapterId) : addAdapter;

  function handleRemove(id: string) {
    const next = runners.filter((r) => r.id !== id);
    onChangeRunners(next);
    if (id === activeRunnerId && next.length > 0) onChangeActiveRunner(next[0]!.id);
  }

  function handleSave(name: string, description: string | undefined, config: unknown) {
    if (dialog.mode === "edit") {
      onChangeRunners(
        runners.map((r) =>
          r.id === dialog.runner.id ? { ...r, name, description, config } : r,
        ),
      );
    } else if (dialog.mode === "add") {
      const runner: RunnerInstance = {
        id: crypto.randomUUID(),
        name,
        description,
        adapterId: HTTP_RUNNER_ADAPTER_ID,
        config,
      };
      onChangeRunners([...runners, runner]);
      onChangeActiveRunner(runner.id);
    }
  }

  if (runners.length === 0) {
    return (
      <p className="text-xs text-zinc-500 dark:text-zinc-400">No runners configured.</p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {runners.map((runner) => (
        <RunnerRow
          key={runner.id}
          runner={runner}
          selected={runner.id === activeRunnerId}
          canRemove={!runner.builtIn && runners.length > 1}
          onSelect={() => onChangeActiveRunner(runner.id)}
          onEdit={() => setDialog({ mode: "edit", runner })}
          onRemove={() => handleRemove(runner.id)}
        />
      ))}

      {addAdapter && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setDialog({ mode: "add" })}
        >
          <Plus className="size-3.5" /> Add runner
        </Button>
      )}

      {dialog.mode !== "closed" && dialogAdapter && (
        <RunnerEditDialog
          open
          onOpenChange={(open) => !open && setDialog({ mode: "closed" })}
          adapter={dialogAdapter}
          isEdit={dialog.mode === "edit"}
          initialName={dialog.mode === "edit" ? dialog.runner.name : undefined}
          initialDescription={dialog.mode === "edit" ? dialog.runner.description : undefined}
          initialConfig={dialog.mode === "edit" ? dialog.runner.config : undefined}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

interface RunnerRowProps {
  runner: RunnerInstance;
  selected: boolean;
  canRemove: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

function RunnerRow({ runner, selected, canRemove, onSelect, onEdit, onRemove }: RunnerRowProps) {
  const adapter = registry.get(runner.adapterId) as RunAdapter<unknown> | undefined;
  const [report, setReport] = useState<AvailabilityReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [caps, setCaps] = useState<RunnerCapabilities | null>(null);
  const [capsLoading, setCapsLoading] = useState(false);

  const baseUrl = runnerUrl(runner);

  // Fetch the runner's own advertised name/description so the row shows what the
  // runner reports — not a stored placeholder. Adapters without a capabilities
  // endpoint skip this and fall back to the adapter's own labels.
  useEffect(() => {
    if (!adapter?.fetchCapabilities) {
      setCaps(null);
      setCapsLoading(false);
      return;
    }
    let cancelled = false;
    setCapsLoading(true);
    adapter
      .fetchCapabilities(runner.config)
      .then((next) => {
        if (!cancelled) setCaps(next);
      })
      .catch(() => {
        // Unreachable / malformed — the availability badge surfaces the fault;
        // here we just fall back to the runner's stored / generic label.
        if (!cancelled) setCaps(null);
      })
      .finally(() => {
        if (!cancelled) setCapsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, baseUrl]);

  const title = caps?.displayName ?? runner.name ?? adapter?.displayName ?? "Runner";
  const description =
    caps?.description ??
    (adapter && !adapter.fetchCapabilities ? adapter.description : runner.description);

  const probe = useCallback(async () => {
    if (!adapter) return;
    setChecking(true);
    setProbeError(null);
    try {
      const syncIssues = adapter.validateConfig(runner.config);
      if (syncIssues.length > 0) {
        setReport({ status: "needs-setup", issues: syncIssues });
        return;
      }
      setReport(await adapter.isAvailable(runner.config));
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : String(err));
      setReport(null);
    } finally {
      setChecking(false);
    }
  }, [adapter, runner.config]);

  useEffect(() => {
    if (!selected) return;
    void probe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, runner.id]);

  return (
    <div
      className={`rounded border ${
        selected
          ? "border-zinc-300 dark:border-zinc-700"
          : "border-zinc-100 dark:border-zinc-800"
      } bg-zinc-50 dark:bg-zinc-900`}
    >
      <div className="flex items-start gap-2 p-3">
        <input
          type="radio"
          checked={selected}
          onChange={onSelect}
          className="mt-0.5 shrink-0 accent-zinc-700 dark:accent-zinc-300"
        />
        <div className="min-w-0 flex-1 cursor-pointer" onClick={onSelect}>
          <div className="flex items-center gap-2">
            {capsLoading ? (
              <span className="flex items-center gap-1.5 text-sm font-medium text-zinc-500 dark:text-zinc-400">
                <Loader2 className="size-3.5 animate-spin" /> Loading…
              </span>
            ) : (
              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</span>
            )}
            {selected && (
              <AvailabilityBadge report={report} checking={checking} probeError={probeError} />
            )}
          </div>
          {!capsLoading && description && (
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{description}</p>
          )}
          <p className="mt-0.5 truncate text-xs text-zinc-400 dark:text-zinc-500">{baseUrl}</p>
        </div>
        {!runner.builtIn && (
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200"
            onClick={onEdit}
            aria-label="Edit runner"
          >
            <Pencil className="size-3.5" />
          </Button>
        )}
        {canRemove && (
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 text-zinc-400 hover:text-red-600 dark:text-zinc-500 dark:hover:text-red-400"
            onClick={onRemove}
            aria-label="Remove runner"
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>

      {selected && (
        <div className="flex items-start justify-between gap-2 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <AvailabilitySummary report={report} checking={checking} probeError={probeError} />
          <div className="flex shrink-0 items-center gap-2">
            {report?.status === "unavailable" && report.action && (
              <ActionButton action={report.action} onDone={probe} />
            )}
            {runner.adapterId === LOCAL_DOCKER_ADAPTER_ID && report?.status === "ready" && (
              <StopLocalRunnerButton onDone={probe} />
            )}
            <Button size="sm" variant="outline" onClick={probe} disabled={checking || !adapter}>
              {checking ? "Checking…" : "Recheck"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function runnerUrl(runner: RunnerInstance): string {
  const config = runner.config as Record<string, unknown> | undefined;
  const baseUrl = config && typeof config.baseUrl === "string" ? config.baseUrl : null;
  return baseUrl ?? runner.adapterId;
}

interface StatusProps {
  report: AvailabilityReport | null;
  checking: boolean;
  probeError: string | null;
}

function AvailabilityBadge({ report, checking, probeError }: StatusProps) {
  if (checking) return <Badge label="Checking…" tone="neutral" />;
  if (probeError) return <Badge label="Probe failed" tone="error" />;
  if (!report) return <Badge label="—" tone="neutral" />;
  if (report.status === "ready") return <Badge label="Ready" tone="success" />;
  if (report.status === "needs-setup") return <Badge label="Setup required" tone="warning" />;
  return <Badge label="Unavailable" tone="error" />;
}

function AvailabilitySummary({ report, checking, probeError }: StatusProps) {
  if (checking) {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400">Checking runner…</p>;
  }
  if (probeError) {
    return <p className="text-xs text-red-600 dark:text-red-400">Probe failed: {probeError}</p>;
  }
  if (!report) return <p className="text-xs text-zinc-400 dark:text-zinc-500">Not checked yet.</p>;
  if (report.status === "ready") {
    return <p className="text-xs text-green-700 dark:text-green-400">Runner ready.</p>;
  }
  if (report.status === "needs-setup") {
    return (
      <div className="text-xs text-amber-700 dark:text-amber-300">
        <p>Setup required:</p>
        <ul className="mt-0.5 list-disc pl-5">
          {report.issues.map((issue: ConfigIssue, i) => (
            <li key={i}>{issue.message}</li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="text-xs text-red-700 dark:text-red-300">
      <p>{report.message}</p>
      {report.remediation && (
        <p className="mt-0.5 text-red-600 dark:text-red-400">{report.remediation}</p>
      )}
      {report.action && (
        <p className="mt-0.5 text-zinc-600 dark:text-zinc-400">{report.action.description}</p>
      )}
    </div>
  );
}

/** Runs an availability report's adapter-provided remedy (e.g. starting the
 *  local runner), then re-probes so the row reflects the new state. */
function ActionButton({ action, onDone }: { action: AvailabilityAction; onDone: () => Promise<void> }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setRunning(true);
    setError(null);
    try {
      await action.run();
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" onClick={handleClick} disabled={running}>
        {running ? (
          <span className="flex items-center gap-1.5">
            <Loader2 className="size-3.5 animate-spin" /> Starting…
          </span>
        ) : (
          action.label
        )}
      </Button>
      {error && (
        <p className="max-w-56 text-right text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}

/** Tears the editor-managed local runner down (stops all its sessions and
 *  removes the container + bundle volume), then re-probes the row. */
function StopLocalRunnerButton({ onDone }: { onDone: () => Promise<void> }) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setStopping(true);
    setError(null);
    try {
      await stopLocalRunner();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
      await onDone();
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" onClick={handleClick} disabled={stopping}>
        {stopping ? "Stopping…" : "Stop local runner"}
      </Button>
      {error && (
        <p className="max-w-56 text-right text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}

function Badge({
  label,
  tone,
}: {
  label: string;
  tone: "neutral" | "success" | "warning" | "error";
}) {
  const classes =
    tone === "success"
      ? "bg-green-100 text-green-700 dark:bg-green-900/60 dark:text-green-200"
      : tone === "warning"
        ? "bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-200"
        : tone === "error"
          ? "bg-red-100 text-red-700 dark:bg-red-900/60 dark:text-red-200"
          : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${classes}`}
    >
      {label}
    </span>
  );
}

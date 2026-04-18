import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { registry } from "../registry";
import type { AvailabilityReport, ConfigIssue, RunAdapter } from "../types";
import { AdapterConfigForm } from "./AdapterConfigForm";

interface RunSettingsSectionProps {
  activeAdapterId: string;
  runAdapterConfig: Record<string, unknown>;
  onChangeActiveAdapter: (id: string) => void;
  onChangeConfig: (id: string, config: unknown) => void;
}

export function RunSettingsSection({
  activeAdapterId,
  runAdapterConfig,
  onChangeActiveAdapter,
  onChangeConfig,
}: RunSettingsSectionProps) {
  const adapters = registry.list();
  const activeAdapter = registry.get(activeAdapterId);
  const activeConfig =
    (runAdapterConfig[activeAdapterId] as unknown) ?? activeAdapter?.defaultConfig;

  if (adapters.length === 0) {
    return (
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {isTauri()
          ? "No run adapters are registered."
          : "Run adapters are only available in the desktop app."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {adapters.map((adapter) => (
        <AdapterRow
          key={adapter.id}
          adapter={adapter}
          selected={adapter.id === activeAdapterId}
          config={runAdapterConfig[adapter.id] ?? adapter.defaultConfig}
          onSelect={() => onChangeActiveAdapter(adapter.id)}
          onChangeConfig={(cfg) => onChangeConfig(adapter.id, cfg)}
        />
      ))}
      {activeAdapter == null && activeConfig == null && (
        // Selected adapter id points at nothing the registry knows about —
        // can happen if the user's persisted setting references an adapter
        // that was removed. The list above offers them an alternative to
        // switch to.
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Saved adapter &quot;{activeAdapterId}&quot; is not available. Pick another above.
        </p>
      )}
    </div>
  );
}

interface AdapterRowProps<Config> {
  adapter: RunAdapter<Config>;
  selected: boolean;
  config: unknown;
  onSelect: () => void;
  onChangeConfig: (config: Config) => void;
}

function AdapterRow<Config>({
  adapter,
  selected,
  config,
  onSelect,
  onChangeConfig,
}: AdapterRowProps<Config>) {
  const typedConfig = config as Config;
  const [report, setReport] = useState<AvailabilityReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  const probe = useCallback(async () => {
    setChecking(true);
    setProbeError(null);
    try {
      const syncIssues = adapter.validateConfig(typedConfig);
      if (syncIssues.length > 0) {
        // Skip the async probe if config is syntactically incomplete — the
        // probe would likely fail in a less actionable way.
        setReport({ status: "needs-setup", issues: syncIssues });
        return;
      }
      const result = await adapter.isAvailable(typedConfig);
      setReport(result);
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : String(err));
      setReport(null);
    } finally {
      setChecking(false);
    }
  }, [adapter, typedConfig]);

  // Probe on first selection. Don't auto-probe on every config keystroke —
  // docker version is slow and noisy; the user triggers Recheck after edits.
  useEffect(() => {
    if (!selected) return;
    void probe();
    // Intentionally depending only on `selected` + `adapter.id`: config
    // changes are picked up via Recheck so the UX is predictable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, adapter.id]);

  return (
    <div
      className={`rounded border ${
        selected
          ? "border-zinc-300 dark:border-zinc-700"
          : "border-zinc-100 dark:border-zinc-800"
      } bg-zinc-50 dark:bg-zinc-900`}
    >
      <label className="flex cursor-pointer items-start gap-2 p-3">
        <input
          type="radio"
          checked={selected}
          onChange={onSelect}
          className="mt-0.5 shrink-0 accent-zinc-700 dark:accent-zinc-300"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {adapter.displayName}
            </span>
            {selected && (
              <AvailabilityBadge
                report={report}
                checking={checking}
                probeError={probeError}
              />
            )}
          </div>
          {adapter.description && (
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              {adapter.description}
            </p>
          )}
        </div>
      </label>

      {selected && (
        <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
          <AdapterConfigForm<Config>
            adapter={adapter}
            value={typedConfig}
            onChange={onChangeConfig}
          />
          <div className="mt-3 flex items-center justify-between gap-2">
            <AvailabilitySummary
              report={report}
              checking={checking}
              probeError={probeError}
            />
            <Button size="sm" variant="outline" onClick={probe} disabled={checking}>
              {checking ? "Checking…" : "Recheck"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
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
  if (report.status === "needs-setup")
    return <Badge label="Setup required" tone="warning" />;
  return <Badge label="Unavailable" tone="error" />;
}

function AvailabilitySummary({ report, checking, probeError }: StatusProps) {
  if (checking) {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400">Checking adapter…</p>;
  }
  if (probeError) {
    return <p className="text-xs text-red-600 dark:text-red-400">Probe failed: {probeError}</p>;
  }
  if (!report) return <p className="text-xs text-zinc-400 dark:text-zinc-500">Not checked yet.</p>;
  if (report.status === "ready") {
    return <p className="text-xs text-green-700 dark:text-green-400">Adapter ready.</p>;
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

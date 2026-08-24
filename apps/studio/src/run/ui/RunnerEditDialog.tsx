import type { JSONSchema7 } from "json-schema";
import { useEffect, useMemo, useState } from "react";

import { ResourceSchemaForm } from "../../components/resource-schema-form";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import type { RunAdapter, RunnerCapabilities } from "../types";
import { applySchemaDefaults, mergeCapabilitySchema } from "./capability-form";

interface RunnerEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adapter: RunAdapter<unknown>;
  isEdit: boolean;
  /** Existing name/description, used as the fallback label when the runner at
   *  the configured URL doesn't advertise capabilities. */
  initialName?: string;
  initialDescription?: string;
  initialConfig?: unknown;
  onSave: (name: string, description: string | undefined, config: unknown) => void;
}

/** Add / edit form for an HTTP runner. There is no name field: the runner is
 *  labelled by its advertised `displayName` / `description`, captured from
 *  `/v1/capabilities` when the URL is reachable (falling back to the existing
 *  label, then the adapter's generic name). The config form is dynamic — it
 *  shows the runner URL plus whatever editable fields the runner advertises. */
export function RunnerEditDialog({
  open,
  onOpenChange,
  adapter,
  isEdit,
  initialName,
  initialDescription,
  initialConfig,
  onSave,
}: RunnerEditDialogProps) {
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [caps, setCaps] = useState<RunnerCapabilities | null>(null);
  const [fetching, setFetching] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "warn" | "error" } | null>(null);

  useEffect(() => {
    if (!open) return;
    setConfig({ ...((initialConfig ?? adapter.defaultConfig) as Record<string, unknown>) });
    setCaps(null);
    setNotice(null);
  }, [open, initialConfig, adapter]);

  const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : "";

  // Fetch the runner's advertised capabilities once the URL settles. Keyed on
  // baseUrl only so editing other fields doesn't re-probe.
  useEffect(() => {
    if (!open || !adapter.fetchCapabilities || baseUrl.trim() === "") return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      setFetching(true);
      setNotice(null);
      try {
        const next = await adapter.fetchCapabilities!({ ...config, baseUrl } as never);
        if (cancelled) return;
        setCaps(next);
        if (next) {
          setConfig((prev) => applySchemaDefaults(next.config.schema as JSONSchema7, prev));
        } else {
          setNotice({
            text: "Runner didn't advertise config fields — only the URL is editable.",
            tone: "warn",
          });
        }
      } catch (err) {
        if (cancelled) return;
        setCaps(null);
        setNotice({
          text: err instanceof Error ? err.message : "Failed to load runner capabilities.",
          tone: "error",
        });
      } finally {
        if (!cancelled) setFetching(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, baseUrl, adapter]);

  const mergedSchema = useMemo(
    () => mergeCapabilitySchema(adapter.configSchema, caps),
    [adapter, caps],
  );

  // The runner labels itself; fall back to the existing label, then the
  // adapter's generic name, when it advertises nothing.
  const resolvedName = caps?.displayName ?? initialName ?? adapter.displayName;
  const resolvedDescription = caps?.description ?? initialDescription;
  const issues = adapter.validateConfig(config as never);
  const canSave = issues.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-120">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit runner" : "Add runner"}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div>
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{resolvedName}</p>
            {resolvedDescription && (
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                {resolvedDescription}
              </p>
            )}
          </div>

          <ResourceSchemaForm
            schema={mergedSchema as unknown as Record<string, unknown>}
            values={config}
            onChange={(next) => setConfig(next as Record<string, unknown>)}
          />

          {fetching && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Loading runner fields…</p>
          )}
          {notice && !fetching && (
            <p
              className={
                notice.tone === "error"
                  ? "text-xs text-red-600 dark:text-red-400"
                  : "text-xs text-amber-600 dark:text-amber-400"
              }
            >
              {notice.text}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canSave}
            onClick={() => {
              onSave(resolvedName, resolvedDescription, config);
              onOpenChange(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { describeAutoMark, describeTeloStatus, describeVersionMark, type VersionMarks } from "@telorun/language-host";
import { AlertTriangle, Loader2, RotateCw } from "lucide-react";
import { useState } from "react";
import type { TeloLanguage } from "../hooks/useLanguageSession";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

const HOST = { product: "studio", setting: "this workspace's telo version setting" };

/**
 * "Telo X" for the active module, the workspace's telo version setting, and
 * the error states — offline and uncached, a pin this editor does not offer,
 * an engine refused by verification, nothing satisfying the module's ranges —
 * each with "Select version" and "Retry".
 */
export function TeloVersionControl({ language }: { language: TeloLanguage }) {
  const [open, setOpen] = useState(false);
  const [marks, setMarks] = useState<VersionMarks | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (language.kind === "failed") {
    return (
      <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400" title={language.failure}>
        <AlertTriangle className="size-3.5" />
        Telo unavailable
      </span>
    );
  }

  const { status, teloVersion } = language;
  const { label, detail } = describeTeloStatus(status, HOST);
  const run = (action: Promise<unknown>) => {
    setActionError(null);
    action.catch((error: unknown) => setActionError(error instanceof Error ? error.message : String(error)));
  };
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) run(language.markVersions().then(setMarks));
  };
  const listed = marks?.versions ?? [];
  const auto = describeAutoMark(marks ?? { versions: [] });
  const current = teloVersion !== "auto" && !listed.some((v) => v.version === teloVersion) ? [teloVersion] : [];

  return (
    <TooltipProvider>
      <div className="flex items-center gap-1.5 text-xs">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={
                status.error
                  ? "flex cursor-default items-center gap-1 text-red-600 dark:text-red-400"
                  : "cursor-default text-zinc-600 dark:text-zinc-300"
              }
              aria-label={detail}
            >
              {status.error && <AlertTriangle className="size-3.5" />}
              {!status.error && status.starting && <Loader2 className="size-3.5 animate-spin" />}
              {label}
            </span>
          </TooltipTrigger>
          <TooltipContent>{actionError ?? detail}</TooltipContent>
        </Tooltip>
        <Select
          value={teloVersion}
          open={open}
          onOpenChange={onOpenChange}
          onValueChange={(value) => run(language.setTeloVersion(value))}
        >
          <SelectTrigger size="sm" className="h-7 text-xs" aria-label="Telo version to edit against">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{auto.detail ? `${auto.label} · ${auto.detail}` : auto.label}</SelectItem>
            {current.map((version) => (
              <SelectItem key={version} value={version}>
                {marks ? `${version} · not offered` : version}
              </SelectItem>
            ))}
            {listed.map((v) => {
              const mark = describeVersionMark(v);
              return (
                <SelectItem key={v.version} value={v.version}>
                  {mark.label} · {mark.detail}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        {status.error && (
          <>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onOpenChange(true)}>
              Select version
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => run(language.retry())}>
              <RotateCw className="size-3.5" />
              Retry
            </Button>
          </>
        )}
      </div>
    </TooltipProvider>
  );
}

import type { MouseEvent } from "react";
import { DiagnosticSeverity } from "@telorun/analyzer";
import type { DiagnosticsSummary } from "../../diagnostics-aggregate";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { DiagnosticPopoverContent } from "./DiagnosticPopoverContent";
import { useDiagnosticsContext } from "./DiagnosticsContext";

type Size = "sm" | "md";

interface Props {
  summary: DiagnosticsSummary | null;
  size?: Size;
  showCount?: boolean;
  /** Stop click/mousedown propagation so placing the badge inside a
   *  clickable row doesn't trigger the row's navigation. Defaults on. */
  stopPropagation?: boolean;
}

const SEVERITY_ICON: Record<DiagnosticSeverity, string> = {
  [DiagnosticSeverity.Error]: "\u25CF",
  [DiagnosticSeverity.Warning]: "\u25B2",
  [DiagnosticSeverity.Information]: "\u24D8",
  [DiagnosticSeverity.Hint]: "\u24D8",
};

const SEVERITY_COLOR: Record<DiagnosticSeverity, string> = {
  [DiagnosticSeverity.Error]: "text-red-500 dark:text-red-400",
  [DiagnosticSeverity.Warning]: "text-amber-500 dark:text-amber-400",
  [DiagnosticSeverity.Information]: "text-sky-500 dark:text-sky-400",
  [DiagnosticSeverity.Hint]: "text-zinc-500 dark:text-zinc-400",
};

const SIZE_CLASS: Record<Size, string> = {
  sm: "text-[0.7rem] gap-0.5",
  md: "text-sm gap-1",
};

export function DiagnosticBadge({
  summary,
  size = "sm",
  showCount = true,
  stopPropagation = true,
}: Props) {
  const ctx = useDiagnosticsContext();
  if (!summary) return null;

  const handleStop = stopPropagation
    ? {
        onClick: (e: MouseEvent) => e.stopPropagation(),
        onMouseDown: (e: MouseEvent) => e.stopPropagation(),
      }
    : {};

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${summary.count} diagnostic${summary.count === 1 ? "" : "s"}`}
          className={`inline-flex items-center rounded px-1 font-medium hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${SIZE_CLASS[size]} ${SEVERITY_COLOR[summary.worstSeverity]}`}
          {...handleStop}
        >
          <span aria-hidden>{SEVERITY_ICON[summary.worstSeverity]}</span>
          {showCount && summary.count > 1 && <span>{summary.count}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(32rem,90vw)]"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <DiagnosticPopoverContent
          diagnostics={summary.diagnostics}
          onNavigate={ctx?.navigate}
        />
      </PopoverContent>
    </Popover>
  );
}

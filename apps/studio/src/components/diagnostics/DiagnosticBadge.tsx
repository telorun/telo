import type { MouseEvent } from "react";
import type { DiagnosticsSummary } from "../../diagnostics-aggregate";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { DiagnosticPopoverContent } from "./DiagnosticPopoverContent";
import { useDiagnosticsContext } from "./DiagnosticsContext";
import { SEVERITY_ICON, SEVERITY_TEXT_COLOR } from "./severity";

type Size = "sm" | "md";

interface Props {
  summary: DiagnosticsSummary | null;
  size?: Size;
  showCount?: boolean;
  /** Stop click/mousedown propagation so placing the badge inside a
   *  clickable row doesn't trigger the row's navigation. Defaults on. */
  stopPropagation?: boolean;
}

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
          className={`inline-flex items-center rounded px-1 font-medium hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${SIZE_CLASS[size]} ${SEVERITY_TEXT_COLOR[summary.worstSeverity]}`}
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

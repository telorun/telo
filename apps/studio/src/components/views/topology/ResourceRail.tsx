import { Boxes, ChevronRight } from "lucide-react";
import { useState } from "react";
import { summarizeResource } from "../../../diagnostics-aggregate";
import { DiagnosticBadge } from "../../diagnostics/DiagnosticBadge";
import { useActiveFilePaths, useDiagnosticsState } from "../../diagnostics/DiagnosticsContext";
import { capLabel } from "./ApplicationTopologyCanvas";
import type { RailSection } from "./topology-view";

/**
 * Resources the canvas does not draw — the module's ambient providers and types,
 * plus whatever the active view leaves out of its own picture.
 *
 * Host-owned, like the module bar, and for the same reason: it used to belong to
 * one canvas, so a provider created while another view was open vanished with no
 * rail to fall back to. What a module contains is true whichever view is
 * showing; only the set a given view declines to draw is that view's own, and
 * that arrives as a section rather than as a second rail beside this one.
 */
export function ResourceRail({
  sections,
  canFocus,
  onFocusResource,
  onSelectResource,
}: {
  sections: RailSection[];
  /** Whether entering this resource shows more than the detail panel does —
   *  false for the ambient providers and types, which have no interior at all. */
  canFocus: (name: string) => boolean;
  onFocusResource: (name: string) => void;
  onSelectResource: (kind: string, name: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const diagState = useDiagnosticsState();
  const filePaths = useActiveFilePaths();

  if (sections.every((section) => section.items.length === 0)) return null;

  if (!open) {
    return (
      <button
        className="flex h-full w-6 shrink-0 items-center justify-center border-l border-zinc-200 text-zinc-400 hover:text-zinc-600 dark:border-zinc-800"
        onClick={() => setOpen(true)}
        title="Show resources not on the canvas"
      >
        <Boxes className="size-4" />
      </button>
    );
  }

  return (
    <div className="flex h-full w-48 shrink-0 flex-col overflow-y-auto border-l border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-1 flex items-center justify-end">
        <button
          className="text-zinc-400 hover:text-zinc-600"
          onClick={() => setOpen(false)}
          title="Collapse"
        >
          <ChevronRight className="size-3.5" />
        </button>
      </div>
      {sections.map((section) =>
        section.items.length === 0 ? null : (
          <div key={section.id} className="mb-2 flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
              {section.title}
            </span>
            {[...section.items]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((item) => {
                const summary = summarizeResource(diagState, filePaths, item.name);
                const focusable = canFocus(item.name);
                return (
                  <div key={`${item.kind} ${item.name}`} className="relative">
                    <button
                      className="w-full rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-left hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
                      onClick={() => {
                        onSelectResource(item.kind, item.name);
                        // Same rule as every other list: the panel always, the
                        // canvas too when there is an interior to enter.
                        if (focusable) onFocusResource(item.name);
                      }}
                    >
                      <div className="truncate pr-5 text-xs font-medium text-zinc-700 dark:text-zinc-200">
                        {item.name}
                      </div>
                      <div className="truncate text-[10px] uppercase tracking-wide text-zinc-400">
                        {capLabel(item.capability)}
                      </div>
                    </button>
                    {summary && (
                      <span className="absolute right-1 top-1">
                        <DiagnosticBadge summary={summary} size="sm" />
                      </span>
                    )}
                  </div>
                );
              })}
          </div>
        ),
      )}
    </div>
  );
}

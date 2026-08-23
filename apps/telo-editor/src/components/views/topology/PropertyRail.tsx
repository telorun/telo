import { ChevronLeft, Settings2 } from "lucide-react";
import { useState } from "react";
import type { ParsedResource, Selection } from "../../../model";
import {
  focusedProperty,
  railProperties,
  railSelection,
  summarizeValue,
} from "./property-rail";

/**
 * What the focused resource DECLARES, beside the canvas that shows what it RUNS.
 *
 * The generalization of {@link ModuleBar}: at the module root the declared half
 * is `imports` / `variables` / `secrets` / `ports` / `exports` and the canvas is
 * `targets`; one level down it is a `Run.Loop`'s `condition`, `maxIterations`,
 * `catches` and `outputs` beside its `steps`. The same split, so it is the same
 * surface rather than a second one — and it is host chrome for the same reason
 * the module bar is: what a resource declares is true whichever view is
 * showing, and none of it is graph data a canvas could draw.
 *
 * It NAVIGATES rather than edits. A row opens a selection and the detail panel
 * renders the form, which is what keeps this from being a second editor able to
 * disagree with the first, and what makes a rail of twenty properties cost one
 * column rather than twenty inline controls.
 */
export function PropertyRail({
  resource,
  schema,
  consumed,
  selection,
  onSelect,
}: {
  resource: ParsedResource;
  /** The focused resource's kind schema. */
  schema: Record<string, unknown>;
  /** Properties the active view is rendering — see `railProperties`. */
  consumed: readonly string[];
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
}) {
  const [open, setOpen] = useState(true);
  const properties = railProperties(schema, consumed);
  if (properties.length === 0) return null;

  if (!open) {
    return (
      <button
        className="flex h-full w-6 shrink-0 items-center justify-center border-r border-zinc-200 text-zinc-400 hover:text-zinc-600 dark:border-zinc-800"
        onClick={() => setOpen(true)}
        title="Show properties"
      >
        <Settings2 className="size-4" />
      </button>
    );
  }

  const active = focusedProperty(selection, resource);

  return (
    <div className="flex h-full w-56 shrink-0 flex-col overflow-y-auto border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-100 px-2 dark:border-zinc-800">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
          Properties
        </span>
        <button
          className="text-zinc-400 hover:text-zinc-600"
          onClick={() => setOpen(false)}
          title="Collapse"
        >
          <ChevronLeft className="size-3.5" />
        </button>
      </div>

      <div className="flex flex-col gap-1 p-2">
        {properties.map((property) => {
          const value = resource.fields[property.name];
          const unset = value === undefined;
          return (
            <button
              key={property.name}
              className={`rounded border px-2 py-1 text-left ${
                active === property.name
                  ? "border-indigo-300 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950"
                  : "border-zinc-200 bg-zinc-50 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
              }`}
              onClick={() => onSelect(railSelection(resource, property))}
            >
              <span className="flex items-baseline gap-1.5">
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-700 dark:text-zinc-200">
                  {typeof property.schema.title === "string" && property.schema.title
                    ? property.schema.title
                    : property.name}
                </span>
                {unset && property.required && (
                  <span className="shrink-0 text-[9px] uppercase tracking-wide text-amber-600 dark:text-amber-400">
                    required
                  </span>
                )}
              </span>
              <span
                className={`block truncate font-mono text-[10px] ${
                  unset ? "text-zinc-300 dark:text-zinc-600" : "text-zinc-400"
                }`}
              >
                {summarizeValue(value)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

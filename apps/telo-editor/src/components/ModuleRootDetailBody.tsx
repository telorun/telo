import { refTargetName } from "./views/topology/overview-graph";

interface ModuleRootTargetsSummaryProps {
  fields: Record<string, unknown>;
}

/** Read-only summary of an Application's `targets` for the detail panel. Targets
 *  are visually edited as edges on the overview canvas, so the panel only shows
 *  them; variables / secrets are edited via the schema form below. Renders
 *  nothing for Libraries (no `targets`). */
export function ModuleRootTargetsSummary({ fields }: ModuleRootTargetsSummaryProps) {
  // `targets` is present (possibly empty) only on Applications.
  const targets = Array.isArray(fields.targets) ? (fields.targets as unknown[]) : null;
  if (!targets) return null;

  return (
    <div className="text-xs">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
        Targets
      </div>
      {targets.length === 0 ? (
        <p className="text-zinc-400 dark:text-zinc-600">
          No targets — work is carried by auto-starting services.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {targets.map((t, i) => (
            <li
              key={i}
              className="rounded border border-zinc-200 bg-zinc-50 px-2 py-1 font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
            >
              {refTargetName(t) ?? String(t)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

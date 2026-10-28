import type { ImportLookupFailure } from "./useUpgradeTargets";

/** The hub could not answer for some imports, so their versions are unknown
 *  here. Said in place, not only logged: a missing upgrade offer reads as
 *  "up to date" otherwise. */
export function ImportLookupNotice({
  failures,
  className = "",
}: {
  failures: ImportLookupFailure[];
  className?: string;
}) {
  if (failures.length === 0) return null;
  return (
    <div
      role="status"
      className={`rounded bg-amber-50 px-2 py-1.5 text-xs leading-tight text-amber-800 dark:bg-amber-950 dark:text-amber-300 ${className}`}
    >
      <strong className="font-semibold">
        Could not check {failures.length === 1 ? "an import" : `${failures.length} imports`} for
        upgrades.
      </strong>{" "}
      {failures.map((failure) => `${failure.source}: ${failure.reason}`).join(" · ")}
    </div>
  );
}

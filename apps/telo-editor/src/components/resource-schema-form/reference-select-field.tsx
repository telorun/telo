import {
  collectRefTargets,
  inferRefMode,
  parseRefValue,
  resolveRefCandidates,
  toRefString,
  toRefValue,
} from "./ref-candidates";
import type { JsonSchemaProperty, ResolvedResourceOption } from "./types";

interface ReferenceSelectFieldProps {
  prop: JsonSchemaProperty;
  value: unknown;
  onValueChange: (next: unknown) => void;
  onBlur: () => void;
  resolvedResources: ResolvedResourceOption[];
  /** Opens the target in the peek panel when the chip is clicked. Omit to
   *  render a plain chip without peek affordance. */
  onSelectResource?: (kind: string, name: string) => void;
}

export function ReferenceSelectField({
  prop,
  value,
  onValueChange,
  onBlur,
  resolvedResources,
  onSelectResource,
}: ReferenceSelectFieldProps) {
  const refTargets = collectRefTargets(prop);
  if (refTargets.length === 0) return null;

  const options = resolveRefCandidates(refTargets, resolvedResources);
  const selected = parseRefValue(value);
  const selectedKey = selected ? toRefString(selected) : "";
  const mode = inferRefMode(prop);
  const hasOptions = options.length > 0;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {selected &&
          (onSelectResource ? (
            <button
              type="button"
              onClick={() => onSelectResource(selected.kind, selected.name)}
              className="rounded border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-800 hover:border-amber-300 hover:text-amber-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-amber-700 dark:hover:text-amber-300"
              title="Peek in side panel"
            >
              {selected.kind}:{selected.name}
            </button>
          ) : (
            <span className="rounded border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
              {selected.kind}:{selected.name}
            </span>
          ))}
        <select
          value={selectedKey}
          onChange={(e) => {
            const next = e.target.value;
            if (!next) {
              onValueChange(undefined);
              return;
            }
            const option = options.find((item) => toRefString(item) === next);
            if (!option) return;
            onValueChange(toRefValue(option, mode));
          }}
          onBlur={onBlur}
          disabled={!hasOptions}
          className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400 dark:disabled:bg-zinc-800"
        >
          <option value="">
            {selected ? "(change)" : hasOptions ? "Set…" : "(no candidates)"}
          </option>
          {options.map((option) => {
            const refValue = toRefString(option);
            return (
              <option key={refValue} value={refValue}>
                {option.kind}:{option.name}
              </option>
            );
          })}
        </select>
      </div>
      {!hasOptions && (
        <span className="text-xs text-red-500">No resolved resources match {refTargets}.</span>
      )}
    </div>
  );
}

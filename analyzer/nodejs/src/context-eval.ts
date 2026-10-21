/**
 * `x-telo-context-eval` — the eval modes an `x-telo-context` binding exists at.
 *
 * Written on a binding as one mode or a list of them (`compile`, `runtime`,
 * `accessor`); absent, the binding exists at every mode. At a site of another
 * mode the scope rule drops it (`cel-scope.ts`), and an accessor field's chain
 * may root only at a binding that lists `accessor` (`eval-paths.ts`). This file
 * is the one reader of the value; its strict half is `validate-match-for.ts`.
 *
 * Browser-safe: no Node built-ins.
 */
import type { CelEvalMode } from "./eval-paths.js";

export const CONTEXT_EVAL = "x-telo-context-eval";

const MODES: readonly CelEvalMode[] = ["compile", "runtime", "accessor"];

const isMode = (value: unknown): value is CelEvalMode =>
  typeof value === "string" && (MODES as readonly string[]).includes(value);

/** The modes `binding` declares, or `undefined` for every mode — the reading of
 *  a malformed value too, which the strict half reports. */
export function contextEvalModes(binding: unknown): readonly CelEvalMode[] | undefined {
  if (!binding || typeof binding !== "object") return undefined;
  const value = (binding as Record<string, unknown>)[CONTEXT_EVAL];
  if (contextEvalValueProblem(value) !== undefined) return undefined;
  return Array.isArray(value) ? (value as CelEvalMode[]) : [value as CelEvalMode];
}

/** Whether `binding` exists at a site of `mode`; an evaluated site of unknown
 *  mode (`undefined`) holds every binding that lists `compile` or `runtime`. */
export function bindingExistsAt(binding: unknown, mode: CelEvalMode | undefined): boolean {
  const modes = contextEvalModes(binding);
  if (!modes) return true;
  return mode === undefined ? modes.includes("compile") || modes.includes("runtime") : modes.includes(mode);
}

/** Why a written value is not one mode or a non-empty list of distinct modes. */
export function contextEvalValueProblem(value: unknown): string | undefined {
  if (value === undefined) return "it is absent";
  if (isMode(value)) return undefined;
  if (!Array.isArray(value)) return "it must be one of 'compile', 'runtime', 'accessor', or a list of them";
  if (value.length === 0) return "the list names no mode";
  const bad = value.find((entry) => !isMode(entry));
  if (bad !== undefined) return `'${String(bad)}' is no mode — use 'compile', 'runtime' or 'accessor'`;
  if (new Set(value).size !== value.length) return "the list names a mode twice";
  return undefined;
}

/**
 * The names the regions, outermost first, leave out of a site of `mode`: each
 * binding as the innermost region declaring its name marks it, so an inner
 * unmarked binding of the same name shadows an outer marked one.
 */
export function bindingsAbsentAt(
  regions: ReadonlyArray<Record<string, any> | undefined>,
  mode: CelEvalMode | undefined,
): string[] {
  const exists = new Map<string, boolean>();
  for (const region of regions) {
    const properties = region?.properties;
    if (!properties || typeof properties !== "object") continue;
    for (const [name, binding] of Object.entries(properties as Record<string, unknown>)) {
      exists.set(name, bindingExistsAt(binding, mode));
    }
  }
  return [...exists].filter(([, present]) => !present).map(([name]) => name);
}

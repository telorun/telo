/**
 * ONE PROPERTY, ONE EVAL MEANING PER UNION — where `EVAL_MODE_BRANCH_CONFLICT`
 * (static) and `ERR_EVAL_MODE_BRANCH_CONFLICT` (the kernel, when it registers a
 * kind) are located and worded. The conflicts themselves are found by the
 * eval-site walk (`evalModeBranchConflicts`, `eval-paths.ts`), which reads
 * every `oneOf` / `anyOf` branch at one path with no value to choose between
 * them: a property two branches declare with different eval sites would carry
 * the union of both in every branch, so it is refused rather than merged.
 *
 * Browser-safe: no Node built-ins.
 */
import { parseCanonicalTypeSchemaId } from "@telorun/sdk";
import type { CelEvalMode, EvalModeBranchConflict } from "./eval-paths.js";
import { renderValuePath, type ValuePath } from "./text-slot.js";

export const EVAL_MODE_BRANCH_CONFLICT = "EVAL_MODE_BRANCH_CONFLICT";

type Schema = Record<string, any>;

const isSchema = (node: unknown): node is Schema =>
  !!node && typeof node === "object" && !Array.isArray(node);

/** Where `target` sits in `root`, by identity. */
function pointerTo(root: unknown, target: object, seen = new Set<object>()): ValuePath | undefined {
  if (root === target) return [];
  if (!root || typeof root !== "object" || seen.has(root)) return undefined;
  seen.add(root);
  const entries: [string | number, unknown][] = Array.isArray(root)
    ? root.map((value, i) => [i, value])
    : Object.entries(root as Schema);
  for (const [key, value] of entries) {
    const inner = pointerTo(value, target, seen);
    if (inner) return [key, ...inner];
  }
  return undefined;
}

/** The differing branch's property, from `root` — the schema document holding
 *  the union, or the named shape a fragment reference entered it through: the
 *  property itself where the branch declares it directly, the branch
 *  otherwise. */
export function conflictLocation(conflict: EvalModeBranchConflict, root: Schema = conflict.document): ValuePath {
  const union = pointerTo(root, conflict.union) ?? pointerTo(conflict.document, conflict.union) ?? [];
  const branch = (conflict.union[conflict.keyword] as unknown[])[conflict.branch];
  const at: ValuePath = [...union, conflict.keyword, conflict.branch];
  if (!isSchema(branch)) return at;
  if (conflict.segment.startsWith(".") && conflict.segment !== ".*") {
    const key = conflict.segment.slice(1);
    return isSchema(branch.properties?.[key]) ? [...at, "properties", key] : at;
  }
  if (conflict.segment === "[*]" && isSchema(branch.items)) return [...at, "items"];
  if (conflict.segment === ".*" && isSchema(branch.additionalProperties)) return [...at, "additionalProperties"];
  return at;
}

function modeText(mode: CelEvalMode | undefined): string {
  switch (mode) {
    case "accessor":
      return "an accessor (`x-telo-eval: accessor`)";
    case "compile":
      return "evaluated at load (`x-telo-eval: compile`)";
    case "runtime":
      return "evaluated per call (`x-telo-eval: runtime`)";
    default:
      return "a literal (no `x-telo-eval`)";
  }
}

/**
 * The refusal, after `subject` — the document declaring the union, worded by
 * the caller (`'Card'`, or a kind reaching a named shape). `root` is that
 * document's schema, written at `schema`.
 */
export function evalModeBranchConflictMessage(
  conflict: EvalModeBranchConflict,
  subject: string,
  root: Schema = conflict.document,
): string {
  const at = pointerTo(root, conflict.union) ?? pointerTo(conflict.document, conflict.union) ?? [];
  const union = renderValuePath(["schema", ...at]);
  const branch = `${conflict.keyword}[${conflict.branch}]`;
  const other = `${conflict.keyword}[${conflict.other}]`;
  const place = conflict.place.startsWith(".") ? conflict.place.slice(1) : conflict.place;
  const what = place === "" ? "the union's own value" : `'${place}'`;
  return (
    `${subject} declares a union at '${union}' whose branches give ${what} two eval modes: ` +
    `${branch} makes it ${modeText(conflict.mode)}, and ${other} makes it ${modeText(conflict.otherMode)}. ` +
    `Every branch is read at one path before a value picks one, so a property means the same in ` +
    `each: give it the same \`x-telo-eval\` in every branch declaring it, or another name where it ` +
    `means something else.`
  );
}

/** The named shape a conflict is in — its canonical id without a fragment,
 *  its module and its name. */
export function conflictShape(
  conflict: EvalModeBranchConflict,
): { id: string; module: string; name: string } | undefined {
  if (!conflict.shape) return undefined;
  const id = conflict.shape.split("#")[0]!;
  const parsed = parseCanonicalTypeSchemaId(id);
  return parsed ? { id, module: parsed.moduleName, name: parsed.typeName } : { id, module: "", name: id };
}

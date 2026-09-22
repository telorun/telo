import { hostAnchorOf, isAbsoluteHostPath } from "@telorun/sdk";
import { unionBranches } from "./schema-compat.js";

/**
 * Whether a schema node holds a `Telo.HostPath` — declared on the node itself,
 * or as a branch of a union beside non-path readings (`anyOf: [{ const:
 * ":memory:" }, { x-telo-type: Telo.HostPath }]`).
 */
export function holdsHostPath(schema: Record<string, any> | undefined): boolean {
  if (!schema) return false;
  return (
    hostAnchorOf(schema) !== undefined ||
    (unionBranches(schema) ?? []).some((branch) => hostAnchorOf(branch) !== undefined)
  );
}

/**
 * The `fromHost` anchor that applies to `text` at this node, or undefined when
 * the text is not a host path here: the node's own anchor, or — at a union —
 * the host-path branch's, unless the text is exactly what a constant branch
 * names (`":memory:"` is not a path beside one).
 */
export function hostAnchorFor(schema: Record<string, any>, text: string): string | undefined {
  const own = hostAnchorOf(schema);
  if (own !== undefined) return own;
  const branches = unionBranches(schema) ?? [];
  if (branches.some((branch) => "const" in branch && branch.const === text)) return undefined;
  for (const branch of branches) {
    const anchor = hostAnchorOf(branch);
    if (anchor !== undefined) return anchor;
  }
  return undefined;
}

/** A string literal opening an expression — the whole of it, or the left
 *  operand of a `+` — with its escapes left as written. */
const LEADING_LITERAL = /^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*(?:\+|$)/;

/**
 * The relative text an expression at a host-path slot starts with, or undefined.
 * A string built from a relative prefix is relative whatever follows it, so this
 * is decided by the expression's text alone; an empty prefix decides nothing, and
 * a constant the slot accepts beside a path (`":memory:"`) is not a path.
 */
export function leadingRelativeLiteral(
  expression: string,
  slot: Record<string, any>,
): string | undefined {
  const match = LEADING_LITERAL.exec(expression);
  const literal = match?.[1] ?? match?.[2];
  if (!literal || isAbsoluteHostPath(literal)) return undefined;
  const constants = (unionBranches(slot) ?? []).map((branch) => branch.const);
  return constants.includes(literal) ? undefined : literal;
}

/** A module doc's `variables:` / `secrets:` entries that hold a host path — what
 *  an importer must supply as one — keyed `variables.<name>`, each with the
 *  constants a union beside the path accepts (`":memory:"`), which are not paths. */
export function hostPathInputs(moduleDoc: Record<string, unknown>): Record<string, string[]> {
  const inputs: Record<string, string[]> = {};
  for (const block of ["variables", "secrets"] as const) {
    const entries = moduleDoc[block];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [name, entry] of Object.entries(entries as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || !holdsHostPath(entry as Record<string, any>)) {
        continue;
      }
      inputs[`${block}.${name}`] = (unionBranches(entry as Record<string, any>) ?? [])
        .filter((branch) => typeof branch.const === "string")
        .map((branch) => branch.const as string);
    }
  }
  return inputs;
}

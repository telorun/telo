/**
 * WHERE IS CEL EVALUATED — the one reader, and the one decision built on it.
 *
 * Two independent ways a value is evaluated, and every consumer needs both:
 * `x-telo-eval` names a field directly, while a REGION annotation
 * (`x-telo-context` / `x-telo-step-context` / `x-telo-error-context`, or a step
 * body) covers everything beneath it — which is how `Run.Choice`'s rows and an
 * `Http.Api` route's `returns:` entries hold expressions while declaring no
 * annotation of their own.
 *
 * The consumers are on both sides of the runtime: `telo check` decides whether a
 * `!cel` here is live (`CEL_IN_NON_EVAL_FIELD`) or resolved at startup
 * (`OBSERVED_STATE_IN_STARTUP_FIELD`), the kernel decides what to expand, and
 * the editor decides whether to offer an expression at all. The editor's answer
 * is a CLAIM that `telo check` will accept what it writes, so a second
 * implementation there is a promise nothing keeps — it read `x-telo-eval` alone
 * and left every predicate inside a region as a bare checkbox, with no way to
 * write the expression the field exists to hold.
 *
 * Browser-safe: no Node built-ins.
 */

import { isStepSlot } from "./step-slot.js";

/**
 * The single containment rule for `x-telo-eval` paths, shared by every matcher so
 * the analyzer's coverage decision and the kernel's expansion/exclusion can't
 * drift. True when `target` lies in the subtree rooted at `evalPath`: `"**"`
 * covers everything; a dotted path covers itself and any descendant — `"handler"`
 * covers `handler`, `handler.body`, `handler[0]`. Targets use `walkCelExpressions`
 * form (`a.b[0].c`); eval paths are property-only (no array segments —
 * `buildEvalPaths` does not descend into `items`), so `.`/`[` boundary prefixing
 * is exact. Consumers: the analyzer's `evalPathsCover`, the kernel's `isExcluded`
 * (applied in both directions), and — structurally — `expandPaths`' navigation.
 */
export function evalPathCovers(evalPath: string, target: string): boolean {
  if (evalPath === "**") return true;
  return (
    target === evalPath || target.startsWith(`${evalPath}.`) || target.startsWith(`${evalPath}[`)
  );
}

/** True when any `x-telo-eval` path in the set covers `exprPath` (see
 *  {@link evalPathCovers}). */
export function evalPathsCover(evalPaths: readonly string[], exprPath: string): boolean {
  return evalPaths.some((p) => evalPathCovers(p, exprPath));
}

/**
 * Traverses a definition schema and collects all paths annotated with `x-telo-eval`.
 * Root-level `x-telo-eval` produces the `"**"` wildcard (expand all fields).
 * Property-level annotations produce the dot-notation path to that property.
 */
export function buildEvalPaths(schema: Record<string, any>): {
  compile: string[];
  runtime: string[];
} {
  const compile: string[] = [];
  const runtime: string[] = [];

  if (schema["x-telo-eval"] === "compile") compile.push("**");
  else if (schema["x-telo-eval"] === "runtime") runtime.push("**");

  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties as Record<string, any>)) {
      collectEvalPathsNode(propSchema, key, compile, runtime);
    }
  }

  return { compile, runtime };
}

function collectEvalPathsNode(
  node: Record<string, any>,
  path: string,
  compile: string[],
  runtime: string[],
): void {
  if (node["x-telo-eval"] === "compile") {
    compile.push(path);
    return;
  }
  if (node["x-telo-eval"] === "runtime") {
    runtime.push(path);
    return;
  }
  if (node.properties) {
    for (const [key, propSchema] of Object.entries(node.properties as Record<string, any>)) {
      collectEvalPathsNode(propSchema, `${path}.${key}`, compile, runtime);
    }
  }
}

/** Schema keys that declare a CEL-bearing region: a field carrying any of these
 *  is evaluated at runtime, so a `!cel` inside it (or a descendant) is live. A
 *  STEP BODY is one too, and says so through the grammar its items point at
 *  rather than through a key — {@link isStepSlot} reads either spelling. */
const CEL_REGION_KEYS = [
  "x-telo-context",
  "x-telo-step-context",
  "x-telo-error-context",
] as const;

/** True when this schema node declares a CEL-bearing region. Node-level, so a
 *  consumer holding one schema (an editor rendering one field) asks it directly
 *  rather than deriving scopes it would then have to match against. */
export function declaresCelRegion(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const node = schema as Record<string, unknown>;
  return CEL_REGION_KEYS.some((key) => node[key] !== undefined) || isStepSlot(node);
}

/**
 * Walk a JSON Schema tree and collect the JSONPath scopes of every field that
 * declares a CEL-bearing region (`x-telo-context` / `x-telo-step-context` /
 * `x-telo-error-context`). Used — alongside `x-telo-eval` paths — to decide
 * whether a `!cel` expression sits in a slot the runtime actually evaluates.
 * Scopes use the same `$.a.b[*]` form as `extractContextsFromSchema`, matched
 * against expression paths with `pathMatchesScope`.
 */
export function extractCelRegionScopes(schema: Record<string, any>, path = "$"): string[] {
  if (!schema || typeof schema !== "object") return [];
  const out: string[] = [];

  if (declaresCelRegion(schema)) out.push(path);

  if (schema.properties) {
    for (const [key, value] of Object.entries(schema.properties as Record<string, any>)) {
      out.push(...extractCelRegionScopes(value, `${path}.${key}`));
    }
  }
  if (schema.items && typeof schema.items === "object") {
    out.push(...extractCelRegionScopes(schema.items, `${path}[*]`));
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(schema[key])) {
      for (const subschema of schema[key]) out.push(...extractCelRegionScopes(subschema, path));
    }
  }

  return out;
}

/**
 * Returns true when a CEL expression path (from walkCelExpressions, e.g. "routes[0].inputs.q")
 * falls within the scope of a context (e.g. "$.routes[*].inputs").
 *
 * The scope is matched directly (no sibling sharing): a context at "$.routes[*].inputs" only
 * applies to expressions whose path starts with "routes[N].inputs", not to other sibling fields.
 */
export function pathMatchesScope(exprPath: string, scope: string): boolean {
  const stripped = scope.startsWith("$.") ? scope.slice(2) : scope;
  if (!stripped) return false;

  // Split on wildcard array segments; each [*] must match a concrete [N] in exprPath
  const parts = stripped.split("[*]");
  let remaining = exprPath;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!remaining.startsWith(part)) return false;
    remaining = remaining.slice(part.length);
    if (i < parts.length - 1) {
      // Expect a concrete array index like [0], [12], ...
      const m = remaining.match(/^\[\d+\]/);
      if (!m) return false;
      remaining = remaining.slice(m[0].length);
    }
  }
  // Expression must end here or continue into a child path
  return remaining === "" || remaining[0] === "." || remaining[0] === "[";
}

/** Every place a schema says its values are evaluated: the `x-telo-eval` paths,
 *  by mode, plus the scopes of the regions that cover their contents. */
export interface CelEvalSites {
  compile: readonly string[];
  runtime: readonly string[];
  regions: readonly string[];
}

export const NO_CEL_EVAL_SITES: CelEvalSites = { compile: [], runtime: [], regions: [] };

export function celEvalSites(schema: Record<string, any> | undefined): CelEvalSites {
  if (!schema) return NO_CEL_EVAL_SITES;
  const { compile, runtime } = buildEvalPaths(schema);
  return { compile, runtime, regions: extractCelRegionScopes(schema) };
}

/** The union of several schemas' sites — a kind's own and its capability
 *  abstract's, which is how a `Telo.Provider`'s implicit compile-eval reaches
 *  fields the provider never annotated. */
export function mergeCelEvalSites(...sites: CelEvalSites[]): CelEvalSites {
  return {
    compile: sites.flatMap((s) => s.compile),
    runtime: sites.flatMap((s) => s.runtime),
    regions: sites.flatMap((s) => s.regions),
  };
}

/**
 * Whether the value at `path` is evaluated, and when — null for a field whose
 * value is read as a literal.
 *
 * `compile` wins over `runtime`, and both win over a region: a field's own
 * annotation is more specific than the region it sits in, which is the same
 * precedence a nested annotation has over an enclosing one. A region resolves to
 * `runtime` because that is what a region IS — a per-invocation scope naming
 * what its expressions can read.
 *
 * `path` is the `walkCelExpressions` spelling (`routes[0].returns[1].when`).
 */
export function celEvalModeAt(
  sites: CelEvalSites,
  path: string,
): "compile" | "runtime" | null {
  if (evalPathsCover(sites.compile, path)) return "compile";
  if (evalPathsCover(sites.runtime, path)) return "runtime";
  if (sites.regions.some((scope) => pathMatchesScope(path, scope))) return "runtime";
  return null;
}

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

import type { ResourceDefinition } from "@telorun/sdk";
import {
  effectiveAuthorSchema,
  inheritedCapability,
  type DefResolver,
} from "./extends-resolution.js";
import { resolveSchemaPointer } from "./manifest-navigation.js";
import { isStepSlot } from "./step-slot.js";

/**
 * THE EVAL-PATH GRAMMAR. A path is the `walkCelExpressions` spelling of where a
 * value sits (`a.b[0].c`), generalized by three pattern forms so an annotation
 * below a map, a list or a recursive `$ref` can be named at all:
 *
 * - `.*` — any one key of a map (`additionalProperties` / `patternProperties`);
 *   a leading `*` for a map at the root;
 * - `[*]` — any one index of a list (`items`);
 * - `(<segments>)*` — the enclosed segments repeated zero or more times, which
 *   is how a schema that refers to itself through a local `$ref` names every
 *   depth at once (`fields.*(.fields.*)*.selector`).
 *
 * `**` is the whole resource. A path without a pattern form is exactly what it
 * was before patterns existed, and is matched by string prefix as before.
 */
const PATTERN_FORM = /[*(]/;

function isEvalPathPattern(path: string): boolean {
  return path !== "**" && PATTERN_FORM.test(path);
}

const patternSources = new Map<string, string>();

/** The regular-expression body of a pattern path. */
function patternSource(pattern: string): string {
  let source = patternSources.get(pattern);
  if (source !== undefined) return source;
  source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (pattern.startsWith("[*]", i)) {
      source += String.raw`\[\d+\]`;
      i += 2;
    } else if (pattern.startsWith(".*", i)) {
      source += String.raw`\.[^.[\]]+`;
      i += 1;
    } else if (c === "*" && i === 0) {
      source += String.raw`[^.[\]]+`;
    } else if (c === "(") {
      source += "(?:";
    } else if (pattern.startsWith(")*", i)) {
      source += ")*";
      i += 1;
    } else if (c === "|") {
      source += "|";
    } else {
      source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  patternSources.set(pattern, source);
  return source;
}

const coverRegexes = new Map<string, RegExp>();
const exactRegexes = new Map<string, RegExp>();

function coverRegex(pattern: string): RegExp {
  let regex = coverRegexes.get(pattern);
  if (!regex) {
    regex = new RegExp(`^${patternSource(pattern)}(?=$|[.[])`);
    coverRegexes.set(pattern, regex);
  }
  return regex;
}

function exactRegex(pattern: string): RegExp {
  let regex = exactRegexes.get(pattern);
  if (!regex) {
    regex = new RegExp(`^${patternSource(pattern)}$`);
    exactRegexes.set(pattern, regex);
  }
  return regex;
}

/**
 * The single containment rule for `x-telo-eval` paths, shared by every matcher so
 * the analyzer's coverage decision and the kernel's expansion/exclusion can't
 * drift. True when `target` lies in the subtree rooted at `evalPath`: `"**"`
 * covers everything; a path covers itself and any descendant — `"handler"`
 * covers `handler`, `handler.body`, `handler[0]`, and `"fields.*.selector"`
 * covers `fields.title.selector`. Targets use `walkCelExpressions` form
 * (`a.b[0].c`). Consumers: the analyzer's `evalPathsCover`, the kernel's
 * `isExcluded` (applied in both directions), and — through
 * {@link concreteEvalPaths} — the kernel's expansion.
 */
export function evalPathCovers(evalPath: string, target: string): boolean {
  if (evalPath === "**") return true;
  if (isEvalPathPattern(evalPath)) return coverRegex(evalPath).test(target);
  return (
    target === evalPath || target.startsWith(`${evalPath}.`) || target.startsWith(`${evalPath}[`)
  );
}

/**
 * The concrete places in `value` an eval path names, each as the key/index
 * segments that reach it. A plain path names at most one place; a pattern names
 * every place in the value it matches exactly. The walk descends only plain
 * objects and arrays — never a value `isLeaf` claims (a compiled expression),
 * bytes, a stream or any other instance, since nothing below one is
 * configuration — and only while the path can still meet the pattern's literal
 * prefix.
 */
export function concreteEvalPaths(
  value: unknown,
  evalPath: string,
  isLeaf: (node: unknown) => boolean = () => false,
): string[][] {
  if (!isEvalPathPattern(evalPath)) return [evalPath.split(".")];
  const exact = exactRegex(evalPath);
  const prefix = evalPath.slice(0, evalPath.search(PATTERN_FORM));
  const out: string[][] = [];
  const walk = (node: unknown, text: string, segments: string[]): void => {
    if (text !== "" && exact.test(text)) {
      out.push(segments);
      return;
    }
    if (!prefix.startsWith(text) && !text.startsWith(prefix)) return;
    if (!node || typeof node !== "object" || isLeaf(node)) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${text}[${index}]`, [...segments, String(index)]));
      return;
    }
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, text === "" ? key : `${text}.${key}`, [...segments, key]);
    }
  };
  walk(value, "", []);
  return out;
}

/** True when any `x-telo-eval` path in the set covers `exprPath` (see
 *  {@link evalPathCovers}). */
export function evalPathsCover(evalPaths: readonly string[], exprPath: string): boolean {
  return evalPaths.some((p) => evalPathCovers(p, exprPath));
}

/**
 * Traverses a definition schema and collects all paths annotated with
 * `x-telo-eval`, in the grammar above. Root-level `x-telo-eval` produces the
 * `"**"` wildcard. Below the root the walk follows `properties`, a map's
 * `additionalProperties` / `patternProperties` (`.*`), a list's `items` (`[*]`)
 * and a document-local `$ref` — one the walk is already inside closes a loop,
 * which becomes a repeated group rather than an endless descent (the
 * `x-telo-error-context` precedent: an annotation reached through `$defs` at any
 * depth). `oneOf` / `anyOf` / `allOf` branches are read at their own path.
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
    const found: EvalSite[] = [];
    for (const [key, propSchema] of Object.entries(schema.properties as Record<string, any>)) {
      collectEvalSites(propSchema, key, schema, [], found);
    }
    for (const site of found) (site.mode === "compile" ? compile : runtime).push(site.path);
  }

  return { compile, runtime };
}

interface EvalSite {
  mode: "compile" | "runtime";
  path: string;
}

interface RefFrame {
  readonly ref: string;
  readonly at: string;
  readonly loops: string[];
}

function collectEvalSites(
  node: unknown,
  path: string,
  root: Record<string, any>,
  frames: readonly RefFrame[],
  out: EvalSite[],
): void {
  if (!node || typeof node !== "object") return;
  const schema = node as Record<string, any>;
  // A node's own annotation wins over whatever its `$ref` leads to.
  if (schema["x-telo-eval"] === "compile" || schema["x-telo-eval"] === "runtime") {
    out.push({ mode: schema["x-telo-eval"], path });
    return;
  }
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#")) {
    const open = frames.find((frame) => frame.ref === schema.$ref);
    if (open) {
      open.loops.push(path.slice(open.at.length));
      return;
    }
    const frame: RefFrame = { ref: schema.$ref, at: path, loops: [] };
    const inside: EvalSite[] = [];
    collectEvalSites(resolveSchemaPointer(root, schema.$ref), path, root, [...frames, frame], inside);
    const loop = frame.loops.length > 0 ? `(${[...new Set(frame.loops)].join("|")})*` : "";
    for (const site of inside) {
      out.push({ mode: site.mode, path: path + loop + site.path.slice(path.length) });
    }
    return;
  }
  const child =(key: string) => (path === "" ? key : `${path}.${key}`);
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties as Record<string, any>)) {
      collectEvalSites(propSchema, child(key), root, frames, out);
    }
  }
  const mapValues = [
    schema.additionalProperties,
    ...Object.values((schema.patternProperties ?? {}) as Record<string, unknown>),
  ];
  for (const value of mapValues) {
    if (value && typeof value === "object") collectEvalSites(value, child("*"), root, frames, out);
  }
  if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    collectEvalSites(schema.items, `${path}[*]`, root, frames, out);
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(schema[key])) {
      for (const branch of schema[key]) collectEvalSites(branch, path, root, frames, out);
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

/**
 * A BASE-FORM CHILD'S OWN FIELDS ARE COMPILE-EVAL WITHOUT ANNOTATION.
 *
 * A definition with `base:` has no controller of its own: the kernel evaluates
 * the mapping once, at `create()`, against `self` — the instance's config — and
 * hands the result to the inherited controller as the parent's config. The
 * child's own schema fields never reach a controller; they exist to be read by
 * `base:`, and the mapping expands whatever compiled value it reads. So every
 * own field is evaluated exactly once at creation against the startup scope,
 * which is what compile-eval IS. Declared here as the rule rather than left as a
 * property of the mapping walk — the `Telo.Provider` posture, where a
 * construction-time-only surface declares compile-eval once for all its fields
 * rather than per field. Without it the rule was off for every inheritance kind
 * (its capability is inherited, so the gate read `undefined`) and the
 * expressions were never typed either: a `!cel "variables.whoo"` passed `telo
 * check` and failed at boot.
 *
 * Read by the kernel's instance production and the analyzer's coverage decision,
 * so the two cannot disagree about which fields a base child evaluates. An
 * explicitly `runtime` own field still wins, through the same overlap rule a
 * root `x-telo-eval: compile` follows.
 */
export const IMPLICIT_COMPILE_SITES: CelEvalSites = { compile: ["**"], runtime: [], regions: [] };

export function implicitEvalSites(
  definition: { base?: unknown } | undefined,
): CelEvalSites {
  return definition?.base != null ? IMPLICIT_COMPILE_SITES : NO_CEL_EVAL_SITES;
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
 * Every place a RESOURCE OF THIS KIND has its values evaluated: the kind's
 * inheritance-resolved schema (an `extends` child is authored against
 * merge(parent, own), and the kernel expands what the merged schema marks), its
 * capability abstract's (a `Telo.Provider`'s implicit root compile-eval), and a
 * base-form child's implicit compile-eval.
 */
export function kindCelEvalSites(
  definition: ResourceDefinition | undefined,
  resolveDef: DefResolver,
): CelEvalSites {
  if (!definition) return NO_CEL_EVAL_SITES;
  const capability = inheritedCapability(definition, resolveDef);
  return mergeCelEvalSites(
    celEvalSites(effectiveAuthorSchema(definition, resolveDef)),
    celEvalSites(
      (capability ? resolveDef(capability)?.schema : undefined) as Record<string, any> | undefined,
    ),
    implicitEvalSites(definition as { base?: unknown }),
  );
}

/**
 * Whether the value at `path` is evaluated, and when — null for a field whose
 * value is read as a literal.
 *
 * An annotated field wins over the region it sits in — a field's own annotation
 * is more specific than an enclosing one, and a region resolves to `runtime`
 * because that is what a region IS, a per-invocation scope naming what its
 * expressions can read. Between the two annotations, `runtime` wins wherever
 * they OVERLAP and `compile` answers everywhere else.
 *
 * That overlap rule is the kernel's, read back: its compile expansion skips any
 * compile path a runtime path contains or is contained by, and under a root
 * `**` it skips per top-level key — so a runtime-annotated field under an
 * implicit compile root stays runtime, here as at dispatch.
 *
 * `path` is the `walkCelExpressions` spelling (`routes[0].returns[1].when`).
 */
export function celEvalModeAt(
  sites: CelEvalSites,
  path: string,
): "compile" | "runtime" | null {
  const compiled = sites.compile.some((p) => {
    if (!evalPathCovers(p, path)) return false;
    const effective = p === "**" ? topLevelKey(path) : p;
    return !sites.runtime.some(
      (rp) => evalPathCovers(rp, effective) || evalPathCovers(effective, rp),
    );
  });
  if (compiled) return "compile";
  if (evalPathsCover(sites.runtime, path)) return "runtime";
  if (sites.regions.some((scope) => pathMatchesScope(path, scope))) return "runtime";
  return null;
}

function topLevelKey(path: string): string {
  const end = path.search(/[.[]/);
  return end === -1 ? path : path.slice(0, end);
}

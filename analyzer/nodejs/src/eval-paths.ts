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
  resolveSchemaReference,
  schemaReferenceParts,
  type NamedShapeLookup,
} from "./schema-reference.js";
import { isStepSlot } from "./step-slot.js";
import { bindingExistsAt } from "./context-eval.js";

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

/** The regular-expression body of a pattern path; with `capture`, every `[*]`
 *  is a group, so a match says where each index sits. */
function patternSource(pattern: string, capture = false): string {
  const key = capture ? `\0${pattern}` : pattern;
  let source = patternSources.get(key);
  if (source !== undefined) return source;
  source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (pattern.startsWith("[*]", i)) {
      source += capture ? String.raw`(\[\d+\])` : String.raw`\[\d+\]`;
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
  patternSources.set(key, source);
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

/** True when `target` is exactly a place `evalPath` names, not one beneath it. */
export function evalPathIs(evalPath: string, target: string): boolean {
  if (evalPath === "**") return false;
  return isEvalPathPattern(evalPath) ? exactRegex(evalPath).test(target) : target === evalPath;
}

/** True when any `x-telo-eval` path in the set covers `exprPath` (see
 *  {@link evalPathCovers}). */
export function evalPathsCover(evalPaths: readonly string[], exprPath: string): boolean {
  return evalPaths.some((p) => evalPathCovers(p, exprPath));
}

export type { NamedShapeLookup };

/** The lookup for a schema read with no named shapes in reach. */
export const NO_NAMED_SHAPES: NamedShapeLookup = () => undefined;

/**
 * Traverses a definition schema and collects all paths annotated with
 * `x-telo-eval`, in the grammar above. Root-level `x-telo-eval` produces the
 * `"**"` wildcard. Below the root the walk follows `properties`, a map's
 * `additionalProperties` / `patternProperties` (`.*`), a list's `items` (`[*]`),
 * a document-local `$ref` and a named shape (through `shapes`) — one the walk is
 * already inside closes a loop, which becomes a repeated group rather than an
 * endless descent. `oneOf` / `anyOf` / `allOf` branches are read at their own
 * path.
 */
export function buildEvalPaths(
  schema: Record<string, any>,
  shapes: NamedShapeLookup = NO_NAMED_SHAPES,
): {
  compile: string[];
  runtime: string[];
} {
  const compile: string[] = [];
  const runtime: string[] = [];

  if (schema["x-telo-eval"] === "compile") compile.push("**");
  else if (schema["x-telo-eval"] === "runtime") runtime.push("**");

  for (const site of collectedOf(schema, shapes).eval) {
    if (site.mode === "compile") compile.push(evalPathOf(site.path));
    else if (site.mode === "runtime") runtime.push(evalPathOf(site.path));
  }

  return { compile, runtime };
}

/**
 * A field annotated `x-telo-eval: accessor`: its value NAMES a value for the
 * resource's consumer to resolve and is never evaluated. `bindings` are the
 * names a chain there may start at — the properties of every `x-telo-context`
 * in force at the field, its own and each one above it.
 */
export interface AccessorSite {
  /** The field, in the eval-path grammar. */
  path: string;
  bindings: readonly string[];
}

/** Every field `schema` annotates `x-telo-eval: accessor`, found by the walk
 *  {@link buildEvalPaths} makes. The annotation is a field's; written on the
 *  schema root it names nothing. */
export function buildAccessorSites(
  schema: Record<string, any>,
  shapes: NamedShapeLookup = NO_NAMED_SHAPES,
): AccessorSite[] {
  return collectedOf(schema, shapes).eval.flatMap((site) =>
    site.mode === "accessor" ? [{ path: evalPathOf(site.path), bindings: site.bindings.present }] : [],
  );
}

/** What `x-telo-eval` says of a field: evaluated at load, evaluated per
 *  invocation, or — `accessor` — named for the resource's consumer and never
 *  evaluated. */
export type CelEvalMode = "compile" | "runtime" | "accessor";

const EVAL_MODES: readonly unknown[] = ["compile", "runtime", "accessor"];

/** The mode this schema node's own `x-telo-eval` declares. Node-level, like
 *  {@link declaresCelRegion}: the reader the path walk below is built on, and
 *  the one a consumer holding a single field's schema asks. */
export function declaredEvalMode(schema: unknown): CelEvalMode | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const mode = (schema as Record<string, unknown>)["x-telo-eval"];
  return EVAL_MODES.includes(mode) ? (mode as CelEvalMode) : undefined;
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
 * `x-telo-error-context`, a step body), through the walk {@link buildEvalPaths}
 * makes. Used — alongside `x-telo-eval` paths — to decide whether a `!cel`
 * expression sits in a slot the runtime actually evaluates. A scope is `$`
 * followed by an eval path (`$.routes[*].inputs`, `$.content(.children[*])*.when`),
 * matched against expression paths with `pathMatchesScope`.
 */
export function extractCelRegionScopes(
  schema: Record<string, any>,
  shapes: NamedShapeLookup = NO_NAMED_SHAPES,
): string[] {
  if (!schema || typeof schema !== "object") return [];
  return collectedOf(schema, shapes).regions.map((path) => `$${path}`);
}

/** One `x-telo-context` region: where it applies and what it declares. */
export interface ContextRegion {
  scope: string;
  schema: Record<string, any>;
}

/**
 * Every `x-telo-context` a schema declares, through the walk
 * {@link buildEvalPaths} makes, with its scope rooted at `prefix` (`$`, or a
 * template body entry's `$.resources[3]`). Several may cover one path: a nested
 * region ADDS to its enclosing ones ({@link contextChainAt}).
 */
export function contextRegionsOf(
  schema: Record<string, any>,
  shapes: NamedShapeLookup = NO_NAMED_SHAPES,
  prefix = "$",
): ContextRegion[] {
  if (!schema || typeof schema !== "object") return [];
  return collectedOf(schema, shapes).contexts.map((context) => ({
    scope: `${prefix}${context.path}`,
    schema: context.schema,
  }));
}

/** A field annotated `x-telo-match-for`, as the walk reaches it: the JSON
 *  Schema-valued field, in the eval-path grammar, and the pointer to the
 *  accessor it is judged against, relative to the object enclosing the field. */
export interface MatchForSite {
  path: string;
  pointer: string;
}

export const MATCH_FOR_ANNOTATION = "x-telo-match-for";

/** Every `x-telo-match-for` field the walk reaches. */
export function matchForSitesOf(
  schema: Record<string, any>,
  shapes: NamedShapeLookup,
): MatchForSite[] {
  return collectedOf(schema, shapes).matchFor.map((site) => ({
    path: evalPathOf(site.path),
    pointer: site.pointer,
  }));
}

/** Every union the walk reaches whose branches give one property two eval
 *  meanings — the one reader of `EVAL_MODE_BRANCH_CONFLICT` and its kernel
 *  twin, so the unions judged are exactly the unions whose sites are merged. */
export function evalModeBranchConflicts(
  schema: Record<string, any> | undefined,
  shapes: NamedShapeLookup = NO_NAMED_SHAPES,
): EvalModeBranchConflict[] {
  if (!schema || typeof schema !== "object") return [];
  return collectedOf(schema, shapes).conflicts.map((found) => ({ ...found, path: evalPathOf(found.path) }));
}

/** An eval path from the walk's spelling, which keeps a leading `.` on every
 *  property so a site found inside a shape composes at any depth. */
function evalPathOf(path: string): string {
  return path.startsWith(".") ? path.slice(1) : path;
}

interface EvalSite {
  mode: CelEvalMode;
  path: string;
  bindings: AccessorNames;
}

/** The context names an accessor chain may root at (`present`), and those a
 *  region declared for other modes only (`hidden`), which shadow an outer
 *  name when a walk inside a shape joins the one that entered it. */
interface AccessorNames {
  readonly present: readonly string[];
  readonly hidden: readonly string[];
}

const NO_NAMES: AccessorNames = { present: [], hidden: [] };

/**
 * Two branches of one `oneOf` / `anyOf` giving a property they both declare
 * different eval sites. The walk reads every branch at one path with no value
 * to choose between them, so the union of their sites would hold for every
 * branch — the conflict is refused instead (`EVAL_MODE_BRANCH_CONFLICT`).
 */
export interface EvalModeBranchConflict {
  /** The union, in the eval-path grammar ("" at the schema root). */
  readonly path: string;
  /** The schema node holding the union, and the schema document it is in. */
  readonly union: Record<string, any>;
  readonly document: Record<string, any>;
  readonly keyword: "oneOf" | "anyOf";
  /** The branch whose sites differ, and the branch it differs from. */
  readonly branch: number;
  readonly other: number;
  /** The property both declare (`.text`, `[*]`, `.*`), or "" for the union's
   *  own value. */
  readonly segment: string;
  /** Where beneath the union the two differ, in the walk's spelling. */
  readonly place: string;
  readonly mode: CelEvalMode | undefined;
  readonly otherMode: CelEvalMode | undefined;
  /** The named shape whose document holds the union; none for the kind's own
   *  schema. */
  readonly shape?: string;
}

/** Everything one walk of a schema finds, paths in the walk's spelling. */
interface Collected {
  eval: EvalSite[];
  regions: string[];
  contexts: Array<{ path: string; schema: Record<string, any> }>;
  matchFor: Array<{ path: string; pointer: string }>;
  conflicts: EvalModeBranchConflict[];
}

const emptyCollected = (): Collected => ({ eval: [], regions: [], contexts: [], matchFor: [], conflicts: [] });

interface Frame {
  readonly node: object;
  readonly at: string;
  readonly loops: string[];
  /** A loop closed on a frame below this one: what was found inside depends on
   *  where the walk entered, so it is not remembered. */
  dirty: boolean;
}

/** What a named shape's walk found, relative to where it is entered. */
interface ShapeMemo {
  loop: string;
  found: Collected;
  shapes: ReadonlyArray<readonly [string, object | undefined]>;
}

/** Memo per shape document: a shape reused at many sites is walked once. Only a
 *  shape whose walk closed no loop outside itself is remembered. */
const shapeMemos = new WeakMap<object, ShapeMemo>();

interface WalkState {
  readonly shapes: NamedShapeLookup;
  /** Every named shape the walk asked for and what the lookup answered — none
   *  included — to tell a remembered shape is still what the lookup answers. */
  readonly resolved: Map<string, object | undefined>;
}

/** What a schema's walk finds. Not remembered per schema: a kind's schema is
 *  rewritten in place while an analysis canonicalizes its references, so its
 *  identity says nothing about what it holds; a named shape is remembered
 *  ({@link shapeMemos}), which is what keeps a reused one walked once. */
function collectedOf(schema: Record<string, any>, shapes: NamedShapeLookup): Collected {
  const state: WalkState = { shapes, resolved: new Map() };
  const found = emptyCollected();
  const own = withContextNames(NO_NAMES, schema);
  if (declaresCelRegion(schema)) found.regions.push("");
  if (isContextNode(schema)) found.contexts.push({ path: "", schema: schema["x-telo-context"] });
  // At the root an `x-telo-eval` is the `**` wildcard, read by the caller, and
  // eval sites are reached through the root's own `properties` alone.
  if (schema.properties && typeof schema.properties === "object") {
    for (const [key, propSchema] of Object.entries(schema.properties as Record<string, any>)) {
      walk(propSchema, `.${key}`, schema, [], found, state, own, false);
    }
  }
  descendBeyondProperties(schema, "", schema, [], found, state, own, true);
  return found;
}

function isContextNode(schema: Record<string, any>): boolean {
  const context = schema["x-telo-context"];
  return !!context && typeof context === "object";
}

/** `names` with a node's own `x-telo-context` applied: a binding existing at
 *  accessor sites joins, one existing at other modes only shadows. */
function withContextNames(names: AccessorNames, schema: Record<string, any>): AccessorNames {
  const context = schema["x-telo-context"];
  if (!context || typeof context !== "object") return names;
  const properties = (context as Record<string, any>).properties;
  if (!properties || typeof properties !== "object") return names;
  return joinNames(names, splitNames(properties as Record<string, unknown>));
}

function splitNames(properties: Record<string, unknown>): AccessorNames {
  const present: string[] = [];
  const hidden: string[] = [];
  for (const [name, binding] of Object.entries(properties)) {
    (bindingExistsAt(binding, "accessor") ? present : hidden).push(name);
  }
  return { present, hidden };
}

/** `outer` with `inner`'s names over it. */
function joinNames(outer: AccessorNames, inner: AccessorNames): AccessorNames {
  if (inner.present.length === 0 && inner.hidden.length === 0) return outer;
  const shadowed = new Set([...inner.present, ...inner.hidden]);
  return {
    present: [...new Set([...outer.present.filter((name) => !shadowed.has(name)), ...inner.present])],
    hidden: [...new Set([...outer.hidden.filter((name) => !shadowed.has(name)), ...inner.hidden])],
  };
}

function walk(
  node: unknown,
  path: string,
  document: Record<string, any>,
  frames: readonly Frame[],
  out: Collected,
  state: WalkState,
  inherited: AccessorNames,
  underEval: boolean,
): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const schema = node as Record<string, any>;
  const bindings = withContextNames(inherited, schema);
  if (declaresCelRegion(schema)) out.regions.push(path);
  if (isContextNode(schema)) out.contexts.push({ path, schema: schema["x-telo-context"] });
  if (typeof schema[MATCH_FOR_ANNOTATION] === "string") {
    out.matchFor.push({ path, pointer: schema[MATCH_FOR_ANNOTATION] });
  }
  // A node's own annotation wins over whatever its `$ref` leads to; nothing
  // below it is an eval site, while regions and contexts below it still are.
  const declared = declaredEvalMode(schema);
  if (declared && !underEval) {
    out.eval.push({ mode: declared, path, bindings });
    underEval = true;
  }
  if (typeof schema.$ref === "string") {
    const { shape } = schemaReferenceParts(schema.$ref);
    const target = resolveSchemaReference(schema.$ref, document, state.shapes);
    if (shape !== undefined) state.resolved.set(shape, target?.document);
    if (!target) return;
    enter(target.node, target.document, target.shape, path, frames, out, state, bindings, underEval);
    return;
  }
  if (schema.properties && typeof schema.properties === "object") {
    for (const [key, propSchema] of Object.entries(schema.properties as Record<string, any>)) {
      walk(propSchema, `${path}.${key}`, document, frames, out, state, bindings, underEval);
    }
  }
  descendBeyondProperties(schema, path, document, frames, out, state, bindings, underEval);
}

function descendBeyondProperties(
  schema: Record<string, any>,
  path: string,
  document: Record<string, any>,
  frames: readonly Frame[],
  out: Collected,
  state: WalkState,
  bindings: AccessorNames,
  underEval: boolean,
): void {
  const mapValues = [
    schema.additionalProperties,
    ...Object.values((schema.patternProperties ?? {}) as Record<string, unknown>),
  ];
  for (const value of mapValues) {
    if (value && typeof value === "object") {
      walk(value, `${path}.*`, document, frames, out, state, bindings, underEval);
    }
  }
  if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    walk(schema.items, `${path}[*]`, document, frames, out, state, bindings, underEval);
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (!Array.isArray(schema[key])) continue;
    // A conjunction is not judged: every member holds at once.
    if (key === "allOf" || underEval) {
      for (const branch of schema[key]) {
        walk(branch, path, document, frames, out, state, bindings, underEval);
      }
      continue;
    }
    const branches: Collected[] = schema[key].map((branch: unknown) => {
      const found = emptyCollected();
      walk(branch, path, document, frames, found, state, bindings, underEval);
      return found;
    });
    out.conflicts.push(...branchConflicts(schema, key, path, document, branches, state.shapes));
    for (const found of branches) {
      out.eval.push(...found.eval);
      out.regions.push(...found.regions);
      out.contexts.push(...found.contexts);
      out.matchFor.push(...found.matchFor);
      out.conflicts.push(...found.conflicts);
    }
  }
}

/**
 * The conflicts between a union's branches: a site at the union's own path
 * with another mode (or none) in another branch, and a property two branches
 * declare whose sites at and beneath it differ. Once per property.
 */
function branchConflicts(
  union: Record<string, any>,
  keyword: "oneOf" | "anyOf",
  path: string,
  document: Record<string, any>,
  branches: readonly Collected[],
  shapes: NamedShapeLookup,
): EvalModeBranchConflict[] {
  if (branches.length < 2) return [];
  const sitesBySegment = branches.map((found) => {
    const bySegment = new Map<string, Map<string, CelEvalMode>>();
    for (const site of found.eval) {
      const place = site.path.slice(path.length);
      const segment = firstSegment(place);
      let sites = bySegment.get(segment);
      if (!sites) bySegment.set(segment, (sites = new Map()));
      sites.set(place, site.mode);
    }
    return bySegment;
  });
  const declared = (union[keyword] as unknown[]).map((branch) =>
    declaredSegments(branch, document, shapes, new Set()),
  );
  const conflicts: EvalModeBranchConflict[] = [];
  const judged = new Set<string>();
  const conflict = (i: number, j: number, segment: string, place: string): void => {
    judged.add(segment);
    const a = sitesBySegment[i]!.get(segment)?.get(place);
    const b = sitesBySegment[j]!.get(segment)?.get(place);
    const [branch, other] = a !== undefined && b === undefined ? [i, j] : [j, i];
    conflicts.push({
      path,
      union,
      document,
      keyword,
      branch,
      other,
      segment,
      place,
      mode: branch === i ? a : b,
      otherMode: branch === i ? b : a,
    });
  };
  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      const own = sitesBySegment[i]!.get("")?.get("");
      const theirs = sitesBySegment[j]!.get("")?.get("");
      if (!judged.has("") && own !== theirs) conflict(i, j, "", "");
      for (const segment of declared[i]!) {
        if (segment === "" || judged.has(segment) || !declared[j]!.has(segment)) continue;
        const mine = sitesBySegment[i]!.get(segment) ?? new Map<string, CelEvalMode>();
        const yours = sitesBySegment[j]!.get(segment) ?? new Map<string, CelEvalMode>();
        const differing =
          [...mine].find(([place, mode]) => yours.get(place) !== mode)?.[0] ??
          [...yours].find(([place, mode]) => mine.get(place) !== mode)?.[0];
        if (differing !== undefined) conflict(i, j, segment, differing);
      }
    }
  }
  return conflicts;
}

/** The first segment of a place beneath a union — past a leading repeated
 *  group, which is read at its zero depth. */
function firstSegment(place: string): string {
  let rest = place;
  while (rest.startsWith("(")) {
    let depth = 0;
    let end = 0;
    for (; end < rest.length; end++) {
      if (rest[end] === "(") depth++;
      else if (rest[end] === ")" && --depth === 0) break;
    }
    rest = rest.slice(end + 2);
  }
  return /^(\[\*\]|\.[^.[(]+)/.exec(rest)?.[1] ?? "";
}

/** The first segments a branch gives a value — its properties, a map's values
 *  and a list's items — through references and nested unions, as the walk
 *  reads them. */
function declaredSegments(
  node: unknown,
  document: Record<string, any>,
  shapes: NamedShapeLookup,
  seen: Set<object>,
): Set<string> {
  const out = new Set<string>();
  if (!node || typeof node !== "object" || Array.isArray(node) || seen.has(node)) return out;
  seen.add(node);
  const schema = node as Record<string, any>;
  if (typeof schema.$ref === "string") {
    const target = resolveSchemaReference(schema.$ref, document, shapes);
    return target ? declaredSegments(target.node, target.document, shapes, seen) : out;
  }
  if (schema.properties && typeof schema.properties === "object") {
    for (const key of Object.keys(schema.properties)) out.add(`.${key}`);
  }
  const mapValues = [
    schema.additionalProperties,
    ...Object.values((schema.patternProperties ?? {}) as Record<string, unknown>),
  ];
  if (mapValues.some((value) => value && typeof value === "object")) out.add(".*");
  if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) out.add("[*]");
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (!Array.isArray(schema[key])) continue;
    for (const branch of schema[key]) {
      for (const segment of declaredSegments(branch, document, shapes, seen)) out.add(segment);
    }
  }
  return out;
}

/**
 * Walk the node a `$ref` names. One already on the descent closes a loop —
 * the segments between its entry and here repeat — and a loop closing on an
 * outer frame marks every frame above it, since what those found depends on
 * where the walk came in.
 */
function enter(
  target: Record<string, any>,
  document: Record<string, any>,
  shape: string | undefined,
  path: string,
  frames: readonly Frame[],
  out: Collected,
  state: WalkState,
  bindings: AccessorNames,
  underEval: boolean,
): void {
  const openAt = frames.findIndex((frame) => frame.node === target);
  if (openAt !== -1) {
    frames[openAt]!.loops.push(path.slice(frames[openAt]!.at.length));
    for (let i = openAt + 1; i < frames.length; i++) frames[i]!.dirty = true;
    return;
  }
  // Everything found inside is relative to the entry and owes its bindings to
  // what the target itself declares; the bindings above it join on the way out.
  // Remembered only while every shape it reached still resolves as it did.
  const isShape = shape !== undefined;
  const known = isShape && !underEval ? shapeMemos.get(target) : undefined;
  const memo = known?.shapes.every(([id, node]) => state.shapes(id) === node) ? known : undefined;
  let loop: string;
  let inside: Collected;
  if (memo) {
    for (const [id, node] of memo.shapes) state.resolved.set(id, node);
    loop = memo.loop;
    inside = memo.found;
  } else {
    const frame: Frame = { node: target, at: path, loops: [], dirty: false };
    const absolute = emptyCollected();
    const resolvedBefore = new Set(state.resolved.keys());
    walk(target, path, document, [...frames, frame], absolute, state, NO_NAMES, underEval);
    loop = frame.loops.length > 0 ? `(${[...new Set(frame.loops)].join("|")})*` : "";
    const relative = (p: string) => p.slice(path.length);
    inside = {
      eval: absolute.eval.map((site) => ({ ...site, path: relative(site.path) })),
      regions: absolute.regions.map(relative),
      contexts: absolute.contexts.map((context) => ({ ...context, path: relative(context.path) })),
      matchFor: absolute.matchFor.map((site) => ({ ...site, path: relative(site.path) })),
      conflicts: absolute.conflicts.map((found) => ({
        ...found,
        path: relative(found.path),
        shape: found.shape ?? shape,
      })),
    };
    if (isShape && !underEval && !frame.dirty) {
      shapeMemos.set(target, {
        loop,
        found: inside,
        shapes: [...state.resolved].filter(([id]) => !resolvedBefore.has(id)),
      });
    }
  }
  const at = (rel: string) => `${path}${loop}${rel}`;
  for (const site of inside.eval) {
    out.eval.push({ ...site, path: at(site.path), bindings: joinNames(bindings, site.bindings) });
  }
  for (const region of inside.regions) out.regions.push(at(region));
  for (const context of inside.contexts) out.contexts.push({ ...context, path: at(context.path) });
  for (const site of inside.matchFor) out.matchFor.push({ ...site, path: at(site.path) });
  for (const found of inside.conflicts) out.conflicts.push({ ...found, path: at(found.path) });
}

/**
 * Returns true when a CEL expression path (from walkCelExpressions, e.g. "routes[0].inputs.q")
 * falls within the scope of a context (e.g. "$.routes[*].inputs").
 *
 * The scope is matched directly (no sibling sharing): a context at "$.routes[*].inputs" only
 * applies to expressions whose path starts with "routes[N].inputs", not to other sibling fields.
 * A scope is `$` followed by an eval path, so a region inside a map value or a recursive shape
 * (`$.content(.children[*])*.when`) matches every place it names.
 */
export function pathMatchesScope(exprPath: string, scope: string): boolean {
  return scopeMatchOf(exprPath, scope) !== undefined;
}

/** Where a scope met an expression path: the concrete `prefix` it matched, and
 *  the end of the last index a `[*]` of the scope matched there (0 when it has
 *  none) — the per-scope item a context's annotations navigate from. */
export interface ScopeMatch {
  prefix: string;
  itemEnd: number;
}

const captureRegexes = new Map<string, RegExp>();

export function scopeMatchOf(exprPath: string, scope: string): ScopeMatch | undefined {
  const stripped = scope.startsWith("$.") ? scope.slice(2) : scope === "$" ? "" : scope;
  if (!stripped) return undefined;
  if (!isEvalPathPattern(stripped)) {
    return evalPathCovers(stripped, exprPath) ? { prefix: stripped, itemEnd: 0 } : undefined;
  }
  let regex = captureRegexes.get(stripped);
  if (!regex) {
    regex = new RegExp(`^${patternSource(stripped, true)}(?=$|[.[])`, "d");
    captureRegexes.set(stripped, regex);
  }
  const match = regex.exec(exprPath);
  if (!match) return undefined;
  let itemEnd = 0;
  for (const span of match.indices?.slice(1) ?? []) {
    if (span && span[1] > itemEnd) itemEnd = span[1];
  }
  return { prefix: match[0], itemEnd };
}

/** Every place a schema says its values are evaluated: the `x-telo-eval` paths,
 *  by mode, plus the scopes of the regions that cover their contents. */
export interface CelEvalSites {
  compile: readonly string[];
  runtime: readonly string[];
  regions: readonly string[];
  /** The fields whose value is an accessor: named, never evaluated. */
  accessor?: readonly AccessorSite[];
}

export const NO_CEL_EVAL_SITES: CelEvalSites = { compile: [], runtime: [], regions: [] };

export function celEvalSites(
  schema: Record<string, any> | undefined,
  shapes: NamedShapeLookup = NO_NAMED_SHAPES,
): CelEvalSites {
  if (!schema) return NO_CEL_EVAL_SITES;
  // One walk for all four views.
  const found = collectedOf(schema, shapes);
  const compile: string[] = schema["x-telo-eval"] === "compile" ? ["**"] : [];
  const runtime: string[] = schema["x-telo-eval"] === "runtime" ? ["**"] : [];
  const accessor: AccessorSite[] = [];
  for (const site of found.eval) {
    if (site.mode === "compile") compile.push(evalPathOf(site.path));
    else if (site.mode === "runtime") runtime.push(evalPathOf(site.path));
    else accessor.push({ path: evalPathOf(site.path), bindings: site.bindings.present });
  }
  return { compile, runtime, regions: found.regions.map((path) => `$${path}`), accessor };
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
    accessor: sites.flatMap((s) => s.accessor ?? []),
  };
}

/** What a kind means along `extends` — the definition registry's answer. */
export interface KindMeanings {
  effectiveKindOf(
    definition: ResourceDefinition | undefined,
  ): { readonly schema?: Record<string, any>; readonly capability?: string } | undefined;
  resolve(kind: string): ResourceDefinition | undefined;
}

/** A definition's effective schema and capability; a definition the registry
 *  does not hold, as written. */
function meaningOf(
  definition: ResourceDefinition,
  kinds: KindMeanings,
): { readonly schema?: Record<string, any>; readonly capability?: string } {
  return (
    kinds.effectiveKindOf(definition) ?? {
      schema: definition.schema as Record<string, any> | undefined,
      capability: definition.capability as string | undefined,
    }
  );
}

/**
 * Every place a RESOURCE OF THIS KIND has its values evaluated: the kind's
 * effective schema (an `extends` child is authored against merge(parent, own),
 * and the kernel expands what the merged schema marks), its capability
 * abstract's (a `Telo.Provider`'s implicit root compile-eval), and a base-form
 * child's implicit compile-eval.
 */
export function kindCelEvalSites(
  definition: ResourceDefinition | undefined,
  kinds: KindMeanings,
  shapes: NamedShapeLookup,
): CelEvalSites {
  if (!definition) return NO_CEL_EVAL_SITES;
  const { schema, capability } = meaningOf(definition, kinds);
  const role = capability ? kinds.resolve(capability) : undefined;
  return mergeCelEvalSites(
    celEvalSites(schema, shapes),
    celEvalSites(role ? meaningOf(role, kinds).schema : undefined, shapes),
    implicitEvalSites(definition as { base?: unknown }),
  );
}

/**
 * The CEL field rule's sites for a resource of this kind, or undefined when no
 * such rule governs the kind: no definition or effective schema, or a
 * structural `Telo.Template` kind whose CEL the kernel evaluates by other rules.
 */
export function governedCelEvalSites(
  definition: ResourceDefinition | undefined,
  kinds: KindMeanings,
  shapes: NamedShapeLookup,
): CelEvalSites | undefined {
  if (!definition) return undefined;
  const { schema, capability } = meaningOf(definition, kinds);
  if (!schema || capability === undefined || capability === "Telo.Template") return undefined;
  return kindCelEvalSites(definition, kinds, shapes);
}

/**
 * What the value at `path` is to evaluation: evaluated at load (`compile`),
 * evaluated per invocation (`runtime`), an accessor field's value or a part of
 * one (`accessor` — named for the consumer, never evaluated), or null for a
 * field whose value is read as a literal.
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
 * implicit compile root stays runtime, here as at dispatch. An accessor field
 * is skipped by itself: everything beside it under the same compile path is
 * still evaluated.
 *
 * `path` is the `walkCelExpressions` spelling (`routes[0].returns[1].when`).
 */
export function celEvalModeAt(sites: CelEvalSites, path: string): CelEvalMode | null {
  if (accessorSiteAt(sites, path)) return "accessor";
  const compiled = sites.compile.some((p) => {
    if (!evalPathCovers(p, path)) return false;
    const effective = p === "**" ? topLevelKey(path) : p;
    return !sites.runtime.some((rp) => evalPathCovers(rp, effective) || evalPathCovers(effective, rp));
  });
  if (compiled) return "compile";
  if (evalPathsCover(sites.runtime, path)) return "runtime";
  if (sites.regions.some((scope) => pathMatchesScope(path, scope))) return "runtime";
  return null;
}

/** The accessor field `path` is, or lies beneath. */
export function accessorSiteAt(sites: CelEvalSites, path: string): AccessorSite | undefined {
  return sites.accessor?.find((site) => evalPathCovers(site.path, path));
}

/** The accessor field `path` IS — not a place beneath one. */
export function accessorFieldAt(sites: CelEvalSites, path: string): AccessorSite | undefined {
  return sites.accessor?.find((site) => evalPathIs(site.path, path));
}

function topLevelKey(path: string): string {
  const end = path.search(/[.[]/);
  return end === -1 ? path : path.slice(0, end);
}

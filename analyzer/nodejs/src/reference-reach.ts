/**
 * What a kind's schema REACHES: every slot through which a resource of it drives
 * another (a reference, a step body) or hands its contents elsewhere (an
 * execution scope, an `x-telo-schema-from` shape) — one traversal, read through
 * views that differ only in what they keep.
 *
 * The traversal decides once where it goes:
 *
 * - a local `$ref` is followed, against the document it sits in; a reference
 *   back to a node already on the descent is a back-edge, recorded rather than
 *   unrolled, so a recursive shape stays finite here;
 * - the root's `properties`, its `anyOf` / `oneOf` / `allOf` branches and its
 *   `additionalProperties` are all walked;
 * - it stops at `x-telo-scope`, at `x-telo-schema-from` and at a step body —
 *   except that a step list whose `items` node is itself a reference slot
 *   (directly or through a local `$ref`) has its items walked as any slot is;
 * - a non-local `$ref` is a stop too: the id is recorded, and a consumer that
 *   can resolve a NAMED SHAPE ({@link ShapeResolver}) walks the shape's own
 *   reach there, against the shape's own document — so a shape recursing with
 *   `$ref: "#"` records its back-edge in its own reach;
 * - a pattern keeps EVERY slot any branch declares there, and each slot keeps
 *   its non-reference alternatives there as value branches.
 *
 * A pattern is a list of segments ({@link Pattern}): a property name exactly as
 * written — a dot or a bracket inside it is part of the name — or a wildcard
 * object for every item of a list (`[]`) or every undeclared key of a map
 * (`{}`). The dotted text (`routes[].handler`) is only ever derived from it, for
 * display and for the string fields consumers already read.
 *
 * Every schema node entered at a pattern is one of its DECLARATIONS, recorded
 * with the `anyOf` / `oneOf` branches it was entered through. Two declarations
 * are ALTERNATIVES when they were entered through different branches of one
 * union, and CONJUNCTS otherwise (the object's own `properties` beside a branch,
 * the members of an `allOf`, a `$ref` and its target). A slot's value branches
 * are its alternatives that carry no reference, each kept with the union members
 * it diverged through ({@link ReachRef.alternatives}); the object enclosing a
 * slot is the conjunct declarations one pattern up ({@link ReachRef.enclosing}).
 *
 * Every consumer reads a view of it rather than resolving a pattern against a
 * value itself: the kernel's Phase-5 substitution and scope creation, inline
 * extraction, `!ref` resolution and every analyzer pass read the CONCRETE SITES
 * of one resource (recursion unrolled as deep as its data goes, static
 * `x-telo-schema-from` slots expanded against the anchor definition's whole
 * schema); the editor's port list reads the DECLARED patterns; the throws walk
 * reads the same sites without the expansion. `x-telo-scope` is legal only on a
 * named top-level property ({@link misplacedScopeSlots}).
 *
 * Browser-safe: no Node built-ins.
 */
import { isRefSentinel } from "@telorun/templating";
import { resolveSchemaPointer } from "./manifest-navigation.js";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import { readRefSlot, type RefSlot } from "./ref-slot.js";
import { readStepSlot, type StepSlot } from "./step-slot.js";
import type {
  RefFieldEntry,
  SchemaFromFieldEntry,
  ScopeFieldEntry,
} from "./reference-field-map.js";

/** A wildcard segment of a {@link Pattern}: every item of a list (`[]`) or
 *  every undeclared key of a map (`{}`). An object, so no property name — not
 *  even one spelled `[]` or `{}` — is ever read as one. */
export interface PatternWildcard {
  readonly wildcard: "[]" | "{}";
}

export const ITEMS: PatternWildcard = Object.freeze({ wildcard: "[]" });
export const MAP_VALUES: PatternWildcard = Object.freeze({ wildcard: "{}" });

/** One step of a pattern: a property name, or a wildcard. */
export type PatternSegment = string | PatternWildcard;

/** Where a slot sits relative to a schema's root, one segment per step. */
export type Pattern = readonly PatternSegment[];

const isWildcard = (segment: PatternSegment, wildcard: "[]" | "{}"): boolean =>
  typeof segment !== "string" && segment.wildcard === wildcard;

/** An injective string for a pattern — the key every per-pattern map uses. */
export function patternKey(pattern: Pattern): string {
  return JSON.stringify(
    pattern.map((segment) => (typeof segment === "string" ? segment : segment.wildcard === "[]" ? 0 : 1)),
  );
}

/** A pattern's dotted spelling (`routes[].handler`, `content.{}.encoder`), for
 *  display only: a property name holding a dot reads the same as two. */
export function patternText(pattern: Pattern): string {
  let out = "";
  for (const segment of pattern) {
    if (isWildcard(segment, "[]")) {
      out += "[]";
      continue;
    }
    const text = typeof segment === "string" ? segment : "{}";
    out = out ? `${out}.${text}` : text;
  }
  return out;
}

/** True when two patterns name the same place. */
export const samePattern = (a: Pattern, b: Pattern): boolean =>
  a.length === b.length && a.every((segment, i) => sameSegment(segment, b[i]!));

const sameSegment = (a: PatternSegment, b: PatternSegment): boolean =>
  typeof a === "string" ? a === b : typeof b !== "string" && a.wildcard === b.wildcard;

const holdsItems = (pattern: Pattern): boolean => pattern.some((s) => isWildcard(s, "[]"));

/** Everything the traversal records at one pattern that drives another. */
export interface ReachPath {
  pattern: Pattern;
  /** Every reference slot declared here, by any branch. */
  refs: RefFieldEntry[];
  /** Every step body declared here, by any branch. */
  steps: StepSlot[];
  /** Back-edges of a recursive schema: the node here is also the one entered at
   *  each of these patterns, so everything below them applies again below this
   *  one, as deep as a resource's data goes. */
  recurse: Pattern[];
}

/** The stops recorded at one pattern: where the traversal hands off. */
export interface ReachStop {
  pattern: Pattern;
  scopes: ScopeFieldEntry[];
  schemaFrom: SchemaFromFieldEntry[];
  /** The ids of the non-local `$ref`s written here. */
  shapes: string[];
}

/** One schema's reach, entered at `node` and resolving `$ref` against `document`. */
export interface SchemaReach {
  document: Record<string, any>;
  node: Record<string, any>;
  /** Per pattern relative to `node`, keyed by {@link patternKey}. */
  paths: Map<string, ReachPath>;
  stops: Map<string, ReachStop>;
  /** Per `{}` pattern, the keys its `additionalProperties` does not apply to:
   *  those the same schema declares under `properties`, plus the resource
   *  envelope at a resource root. Where several schemas meet at one `{}`
   *  pattern, only keys every one of them declares are skipped. Keyed by
   *  {@link patternKey}. */
  declaredKeys: Map<string, Set<string>>;
  /** True when some pattern holds a step or reference slot. */
  drives: boolean;
  /** Every `x-telo-scope` node reached, with the pattern it applies at and
   *  where it is written in `document` (`properties.with`, `$defs.With`). */
  scopeNodes: ScopeNode[];
  /** Per pattern ({@link patternKey}), every schema node entered there, in the
   *  order entered. */
  declarations: Map<string, Declaration[]>;
}

/** One `anyOf` / `oneOf` branch a declaration was entered through. */
export interface BranchChoice {
  /** The union's branch array, by identity. */
  union: object;
  index: number;
  /** The pattern the union is written at, relative to the reach's node. */
  path: Pattern;
}

/** A schema node entered at a pattern, with the union branches that led to it. */
export interface Declaration {
  node: Record<string, any>;
  branches: readonly BranchChoice[];
}

/** True when two declarations were entered through different branches of one
 *  `anyOf` / `oneOf` — a value may satisfy either, never both at once. */
export function areAlternatives(a: Declaration, b: Declaration): boolean {
  return a.branches.some((x) => b.branches.some((y) => x.union === y.union && x.index !== y.index));
}

export interface ScopeNode {
  path: Pattern;
  node: Record<string, any>;
  location: string;
}

/** A local reference resolved: the node, and the document ITS references
 *  resolve against. */
export interface ResolvedSchemaNode {
  document: Record<string, any>;
  node: Record<string, any>;
}

/** Resolves a static `x-telo-schema-from` expression written in `document` to
 *  the anchor node and the anchor definition's whole schema, or undefined when
 *  it is not statically resolvable. */
export type SchemaFromResolver = (
  schemaFrom: string,
  document: Record<string, any>,
) => ResolvedSchemaNode | undefined;

/** Resolves a non-local `$ref` written in `document` to the schema of the named
 *  shape it names, or undefined when it names none. A shape is its own
 *  document. */
export type ShapeResolver = (
  ref: string,
  document: Record<string, any>,
) => Record<string, any> | undefined;

/** The resource envelope: present on every resource document, and never
 *  configuration a kind's root `additionalProperties` describes. */
const RESOURCE_ENVELOPE_KEYS = ["kind", "metadata"];

/** The node a local `$ref` names in `document`. A non-local reference is not
 *  followed. */
export function resolveLocalReference(
  node: Record<string, any>,
  document: Record<string, any>,
): ResolvedSchemaNode | undefined {
  const ref = node.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#")) return undefined;
  const target = resolveSchemaPointer(document, ref);
  if (!target || typeof target !== "object" || Array.isArray(target)) return undefined;
  return { document, node: target as Record<string, any> };
}

/** The reference field entry a ref-slot node records at `path`. */
export function refFieldEntryOf(
  slot: RefSlot,
  node: Record<string, any>,
  path: Pattern,
): RefFieldEntry {
  const entry: RefFieldEntry = {
    refs: slot.kinds,
    uses: slot.uses,
    isArray: holdsItems(path),
  };
  if (slot.useCases) entry.useCases = slot.useCases;
  if (slot.inputs !== undefined) entry.inputs = slot.inputs;
  if (slot.valueBranches.length > 0) entry.valueBranches = slot.valueBranches;
  if (node["x-telo-context"]) entry.context = node["x-telo-context"] as Record<string, any>;
  if (slot.inline) entry.inline = true;
  if (slot.throwsThrough) entry.throwsThrough = true;
  if (slot.outputType) entry.outputType = slot.outputType;
  if (slot.observes) entry.observes = slot.observes;
  return entry;
}

/** The slot an entry records, as `readRefSlot` read it. */
export function refSlotOfEntry(entry: RefFieldEntry): RefSlot {
  const slot: RefSlot = {
    kinds: entry.refs,
    uses: entry.uses,
    inline: entry.inline === true,
    valueBranches: entry.valueBranches ?? [],
  };
  if (entry.useCases) slot.useCases = entry.useCases;
  if (entry.inputs !== undefined) slot.inputs = entry.inputs;
  if (entry.throwsThrough) slot.throwsThrough = true;
  if (entry.outputType) slot.outputType = entry.outputType;
  if (entry.observes) slot.observes = entry.observes;
  return slot;
}

const branchDocuments = new WeakMap<object, Record<string, any>>();
const branchSchemas = new WeakMap<object, Record<string, any>>();

/** A value branch as a schema that compiles on its own: the `$defs` /
 *  `definitions` of the document its slot was declared in sit beside it, so a
 *  local `$ref` inside the branch resolves. */
export function valueBranchSchema(branch: Record<string, any>): Record<string, any> {
  const document = branchDocuments.get(branch);
  if (!document || document === branch) return branch;
  const { $defs, definitions } = document;
  if ($defs === undefined && definitions === undefined) return branch;
  let wrapped = branchSchemas.get(branch);
  if (!wrapped) {
    wrapped = {
      allOf: [branch],
      ...($defs !== undefined ? { $defs } : {}),
      ...(definitions !== undefined ? { definitions } : {}),
    };
    branchSchemas.set(branch, wrapped);
  }
  return wrapped;
}

/** Each reference entry's own declaration, for the enclosing object and the
 *  value alternatives. */
const entryDeclarations = new WeakMap<RefFieldEntry, Declaration>();

/** A value alternative of a slot: its declaration at the slot's pattern, and
 *  each union branch it was entered through where the slot was not. */
interface DeclaredAlternative {
  node: Record<string, any>;
  diverging: BranchChoice[];
}

const entryAlternatives = new WeakMap<RefFieldEntry, DeclaredAlternative[]>();

const resourceReaches = new WeakMap<object, SchemaReach>();
const enteredReaches = new WeakMap<object, WeakMap<object, SchemaReach>>();

/** The reach of a kind's schema, entered at its root as a resource's. Memoized
 *  per schema object. */
export function reachOfSchema(schema: Record<string, any>): SchemaReach {
  let reach = resourceReaches.get(schema);
  if (!reach) {
    reach = traverse(schema, schema, true);
    resourceReaches.set(schema, reach);
  }
  return reach;
}

/** The reach of `node`, a schema inside `document` entered as a value rather
 *  than a resource (a schema-from anchor). Memoized per (document, node). */
export function reachOfNode(document: Record<string, any>, node: Record<string, any>): SchemaReach {
  let byNode = enteredReaches.get(document);
  if (!byNode) enteredReaches.set(document, (byNode = new WeakMap()));
  let reach = byNode.get(node);
  if (!reach) {
    reach = traverse(document, node, false);
    byNode.set(node, reach);
  }
  return reach;
}

interface Walk {
  reach: SchemaReach;
  envelope: boolean;
  /** Per pattern ({@link patternKey}), the schema nodes already recorded there:
   *  one node reached twice at one pattern (two branches `$ref`-ing one
   *  definition) is one slot. */
  recorded: Map<string, Set<object>>;
  /** Each node on the current descent, with the pattern it was entered at. */
  onStack: Map<object, Pattern>;
  /** The `anyOf` / `oneOf` branches the current descent went through. */
  branches: BranchChoice[];
  /** Per pattern, the nodes already recorded as declarations there. */
  declared: Map<string, Set<object>>;
}

function traverse(
  document: Record<string, any>,
  node: Record<string, any>,
  envelope: boolean,
): SchemaReach {
  const reach: SchemaReach = {
    document,
    node,
    paths: new Map(),
    stops: new Map(),
    declaredKeys: new Map(),
    drives: false,
    scopeNodes: [],
    declarations: new Map(),
  };
  const walk: Walk = {
    reach,
    envelope,
    recorded: new Map(),
    onStack: new Map([[node, []]]),
    branches: [],
    declared: new Map(),
  };
  visitNode(node, [], locationIn(document, node), walk);
  addValueAlternatives(reach);
  return reach;
}

function declare(walk: Walk, path: Pattern, node: Record<string, any>): Declaration {
  const key = patternKey(path);
  let nodes = walk.declared.get(key);
  if (!nodes) walk.declared.set(key, (nodes = new Set()));
  let list = walk.reach.declarations.get(key);
  if (!list) walk.reach.declarations.set(key, (list = []));
  if (nodes.has(node)) return list.find((d) => d.node === node)!;
  nodes.add(node);
  const declaration: Declaration = { node, branches: [...walk.branches] };
  list.push(declaration);
  return declaration;
}

/** True when `node`, through its local `$ref` chain, is a reference slot. */
function isReferenceNode(node: Record<string, any>, document: Record<string, any>): boolean {
  const seen = new Set<object>();
  let current: Record<string, any> | undefined = node;
  while (current && !seen.has(current)) {
    seen.add(current);
    const slot = readRefSlot(current);
    if (slot && slot.kinds.length > 0) return true;
    current = typeof current.$ref === "string" ? resolveLocalReference(current, document)?.node : undefined;
  }
  return false;
}

/** Each reference slot takes the non-reference declarations that are its
 *  alternatives at its pattern as value branches, keeping the union members
 *  each diverged through; every value branch and member records the document it
 *  resolves against. */
function addValueAlternatives(reach: SchemaReach): void {
  for (const [key, at] of reach.paths) {
    for (const entry of at.refs) {
      const own = entryDeclarations.get(entry);
      const alternatives = own
        ? (reach.declarations.get(key) ?? []).filter(
            (d) => areAlternatives(d, own) && !isReferenceNode(d.node, reach.document),
          )
        : [];
      if (alternatives.length > 0) {
        entry.valueBranches = [...(entry.valueBranches ?? []), ...alternatives.map((d) => d.node)];
        entryAlternatives.set(
          entry,
          alternatives.map((d) => ({
            node: d.node,
            diverging: d.branches.filter((x) =>
              own!.branches.some((y) => x.union === y.union && x.index !== y.index),
            ),
          })),
        );
      }
      for (const branch of entry.valueBranches ?? []) {
        if (!branchDocuments.has(branch)) branchDocuments.set(branch, reach.document);
      }
      for (const { diverging } of entryAlternatives.get(entry) ?? []) {
        for (const choice of diverging) {
          const member = unionMember(choice);
          if (!branchDocuments.has(member)) branchDocuments.set(member, reach.document);
        }
      }
    }
  }
}

function unionMember(choice: BranchChoice): Record<string, any> {
  return (choice.union as Record<string, any>[])[choice.index]!;
}

/** The pattern of the object enclosing `path`'s value: `routes[].handler` →
 *  `routes[]`, `targets[]` → the root, `a.{}` → `a`. */
function enclosingPattern(path: Pattern): Pattern {
  let end = path.length;
  while (end > 0 && isWildcard(path[end - 1]!, "[]")) end--;
  return path.slice(0, Math.max(end - 1, 0));
}

const enclosingMemo = new WeakMap<RefFieldEntry, Record<string, any>[]>();

/** The conjunct declarations of the object enclosing a slot, in entry order. */
function enclosingDeclarations(
  reach: SchemaReach,
  declaredPath: Pattern,
  entry: RefFieldEntry,
): Record<string, any>[] {
  let out = enclosingMemo.get(entry);
  if (out) return out;
  const own = entryDeclarations.get(entry);
  out = (reach.declarations.get(patternKey(enclosingPattern(declaredPath))) ?? [])
    .filter((d) => !own || !areAlternatives(d, own))
    .map((d) => d.node);
  enclosingMemo.set(entry, out);
  return out;
}

/** A dotted location or concrete path one key further — display spelling. */
const joinKey = (path: string, key: string): string => (path ? `${path}.${key}` : key);

/** Where `node` sits in `document`, found by identity; "" for the root. A node
 *  not inside the document (a caller-built view) reads as its root. */
function locationIn(document: Record<string, any>, node: object): string {
  if (node === document) return "";
  const seen = new Set<object>();
  const search = (value: unknown, at: string): string | undefined => {
    if (!value || typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    if (value === node) return at;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const found = search(value[i], `${at}[${i}]`);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    for (const [key, child] of Object.entries(value)) {
      const found = search(child, joinKey(at, key));
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return search(document, "") ?? "";
}

/** The location a local `$ref` names in its document. */
function pointerLocation(ref: string): string {
  return ref
    .slice(1)
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .join(".");
}

function firstTime(walk: Walk, path: Pattern, node: object): boolean {
  const key = patternKey(path);
  let nodes = walk.recorded.get(key);
  if (!nodes) walk.recorded.set(key, (nodes = new Set()));
  if (nodes.has(node)) return false;
  nodes.add(node);
  return true;
}

function pathAt(walk: Walk, path: Pattern): ReachPath {
  const key = patternKey(path);
  let entry = walk.reach.paths.get(key);
  if (!entry) walk.reach.paths.set(key, (entry = { pattern: path, refs: [], steps: [], recurse: [] }));
  return entry;
}

function stopAt(walk: Walk, path: Pattern): ReachStop {
  const key = patternKey(path);
  let entry = walk.reach.stops.get(key);
  if (!entry) {
    walk.reach.stops.set(key, (entry = { pattern: path, scopes: [], schemaFrom: [], shapes: [] }));
  }
  return entry;
}

function visitNode(node: unknown, path: Pattern, loc: string, walk: Walk): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const schema = node as Record<string, any>;
  const declaration = declare(walk, path, schema);
  if ("x-telo-scope" in schema) {
    if (firstTime(walk, path, schema)) {
      stopAt(walk, path).scopes.push({ scope: schema["x-telo-scope"] });
      walk.reach.scopeNodes.push({ path, node: schema, location: loc });
    }
    return;
  }
  if ("x-telo-schema-from" in schema) {
    if (firstTime(walk, path, schema)) {
      stopAt(walk, path).schemaFrom.push({ schemaFrom: schema["x-telo-schema-from"] });
    }
    return;
  }
  const step = readStepSlot(schema);
  if (step) {
    if (firstTime(walk, path, schema)) {
      pathAt(walk, path).steps.push(step);
      walk.reach.drives = true;
    }
    // A step list whose items are THEMSELVES a reference slot (a boot target: a
    // bare reference, or an object whose branches hold further slots) is walked
    // as any slot is; a list of step objects stays a stop.
    if (itemsAreReferenceSlot(schema.items, walk)) {
      visitNode(schema.items, [...path, ITEMS], joinKey(loc, "items"), walk);
    }
    return;
  }
  const slot = readRefSlot(schema);
  if (slot && slot.kinds.length > 0) {
    if (firstTime(walk, path, schema)) {
      const entry = refFieldEntryOf(slot, schema, path);
      entryDeclarations.set(entry, declaration);
      pathAt(walk, path).refs.push(entry);
      walk.reach.drives = true;
    }
    // A slot's branches may be object shapes carrying their OWN nested slots
    // (Application `targets`: a bare ref vs an inline `{ invoke }`).
    visitVariants(schema, path, loc, walk);
    return;
  }
  if (typeof schema.$ref === "string" || isRefSentinel(schema)) {
    followRef(schema, path, walk);
    return;
  }
  if (schema.type === "array" && schema.items) {
    visitNode(schema.items, [...path, ITEMS], joinKey(loc, "items"), walk);
  }
  visitProperties(schema, path, loc, walk);
  visitVariants(schema, path, loc, walk);
  visitMapValue(schema, path, loc, walk);
}

/** True when a step list's `items` node — directly or through a local `$ref` —
 *  carries a reference slot of its own. */
function itemsAreReferenceSlot(items: unknown, walk: Walk): boolean {
  if (!items || typeof items !== "object" || Array.isArray(items)) return false;
  let node = items as Record<string, any>;
  if (typeof node.$ref === "string") {
    const target = resolveLocalReference(node, walk.reach.document);
    if (!target) return false;
    node = target.node;
  }
  const slot = readRefSlot(node);
  return !!slot && slot.kinds.length > 0;
}

function visitProperties(schema: Record<string, any>, path: Pattern, loc: string, walk: Walk): void {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object") return;
  for (const [key, propSchema] of Object.entries(properties)) {
    visitNode(propSchema, [...path, key], joinKey(joinKey(loc, "properties"), key), walk);
  }
}

function visitVariants(schema: Record<string, any>, path: Pattern, loc: string, walk: Walk): void {
  for (const variantKey of ["oneOf", "anyOf", "allOf"] as const) {
    const variants = schema[variantKey];
    if (!Array.isArray(variants)) continue;
    const disjunct = variantKey !== "allOf";
    variants.forEach((variant, i) => {
      if (!variant || typeof variant !== "object") return;
      if (disjunct) walk.branches.push({ union: variants, index: i, path });
      try {
        visitVariant(variant, path, `${joinKey(loc, variantKey)}[${i}]`, walk);
      } finally {
        if (disjunct) walk.branches.pop();
      }
    });
  }
}

/** One branch of a union. Its own root is not a slot — `readRefSlot` already
 *  unioned an `anyOf` of reference branches at the parent — so only what lies
 *  below it is walked, and a `$ref` branch is followed as a node of its own. */
function visitVariant(variant: Record<string, any>, path: Pattern, loc: string, walk: Walk): void {
  declare(walk, path, variant);
  if (typeof variant.$ref === "string" || isRefSentinel(variant)) {
    followRef(variant, path, walk);
    return;
  }
  visitProperties(variant, path, loc, walk);
  if (variant.type === "array" && variant.items) {
    visitNode(variant.items, [...path, ITEMS], joinKey(loc, "items"), walk);
  }
  visitMapValue(variant, path, loc, walk);
}

/** A local `$ref` is followed; a non-local one is recorded as a stop, and so is
 *  a `!ref <Shape>` still unresolved where a schema belongs — in the authoring
 *  spelling `telo://<authority>/<Shape>` names the same shape by. */
function followRef(node: Record<string, any>, path: Pattern, walk: Walk): void {
  const ref = isRefSentinel(node) ? shapeRefOfSentinel(node) : (node.$ref as string);
  if (ref === undefined) return;
  if (ref.startsWith("#")) {
    followLocalRef(node, path, walk);
    return;
  }
  const stop = stopAt(walk, path);
  if (!stop.shapes.includes(ref)) stop.shapes.push(ref);
}

function shapeRefOfSentinel(sentinel: unknown): string | undefined {
  const target = refSentinelTarget(sentinel);
  return target ? `telo://${target.alias ?? "Self"}/${target.name}` : undefined;
}

/** A reference to a node already on the descent records a back-edge to the
 *  pattern it was entered at; a cycle that made no structural progress (same
 *  pattern) records nothing, since its body is already recorded there. */
function followLocalRef(node: Record<string, any>, path: Pattern, walk: Walk): void {
  const target = resolveLocalReference(node, walk.reach.document);
  if (!target || target.node === node) return;
  const entered = walk.onStack.get(target.node);
  if (entered !== undefined) {
    if (!samePattern(entered, path)) {
      const at = pathAt(walk, path);
      if (!at.recurse.some((to) => samePattern(to, entered))) at.recurse.push(entered);
    }
    return;
  }
  walk.onStack.set(target.node, path);
  try {
    visitNode(target.node, path, pointerLocation(node.$ref as string), walk);
  } finally {
    walk.onStack.delete(target.node);
  }
}

function visitMapValue(owner: Record<string, any>, path: Pattern, loc: string, walk: Walk): void {
  const valueSchema = owner.additionalProperties;
  if (!valueSchema || typeof valueSchema !== "object" || Array.isArray(valueSchema)) return;
  const mapPath = [...path, MAP_VALUES];
  const mapKey = patternKey(mapPath);
  const declared =
    owner.properties && typeof owner.properties === "object" ? Object.keys(owner.properties) : [];
  if (path.length === 0 && walk.envelope) declared.push(...RESOURCE_ENVELOPE_KEYS);
  const previous = walk.reach.declaredKeys.get(mapKey);
  walk.reach.declaredKeys.set(
    mapKey,
    new Set(previous ? declared.filter((key) => previous.has(key)) : declared),
  );
  visitNode(valueSchema, mapPath, joinKey(loc, "additionalProperties"), walk);
}

/** The reaches a stop hands off to: each static schema-from anchor, and each
 *  named shape a non-local `$ref` there resolves to. */
function expansionsAt(
  stop: ReachStop,
  reach: SchemaReach,
  schemaFrom: SchemaFromResolver | undefined,
  shapes: ShapeResolver | undefined,
): { reach: SchemaReach; anchor: boolean }[] {
  const out: { reach: SchemaReach; anchor: boolean }[] = [];
  if (schemaFrom) {
    for (const { schemaFrom: expression } of stop.schemaFrom) {
      const anchor = schemaFrom(expression, reach.document);
      if (anchor) out.push({ reach: reachOfNode(anchor.document, anchor.node), anchor: true });
    }
  }
  if (shapes) {
    for (const id of stop.shapes) {
      const shape = shapes(id, reach.document);
      if (shape) out.push({ reach: reachOfNode(shape, shape), anchor: false });
    }
  }
  return out;
}

// --- the declared-slot view -------------------------------------------------

/** A reference pattern a kind's schema declares, with every slot any branch
 *  declares there. */
export interface DeclaredReference {
  /** The pattern, relative to the resource root, in its dotted spelling. */
  path: string;
  /** The same pattern as segments — exact for a key holding a dot. */
  fieldKeys: Pattern;
  isArray: boolean;
  /** Every accepted kind, unioned across the entries in declaration order. */
  kinds: string[];
  /** Every entry declared at the pattern; `isArray` is the pattern's. */
  entries: RefFieldEntry[];
}

/** A stop a kind's schema declares at a pattern. */
export interface DeclaredStop {
  path: string;
  scopes: ScopeFieldEntry[];
  schemaFrom: SchemaFromFieldEntry[];
  /** True when a schema-from anchor's schema declares it, not the kind's own
   *  or a named shape the kind's own reaches. */
  viaAnchor: boolean;
}

export interface DeclaredReach {
  references: DeclaredReference[];
  stops: DeclaredStop[];
}

/**
 * The patterns a kind's schema declares. A recursive slot's pattern is its
 * outermost occurrence. With `schemaFrom`, a static schema-from stop also
 * contributes the patterns of its anchor, rooted at the stop's pattern, and
 * with `shapes` a named shape contributes its own the same way; a chain leading
 * back to a reach already being expanded stops there.
 */
export function declaredReach(
  schema: Record<string, any>,
  schemaFrom?: SchemaFromResolver,
  shapes?: ShapeResolver,
): DeclaredReach {
  const references = new Map<string, DeclaredReference>();
  const stops: DeclaredStop[] = [];
  const expanding = new Set<SchemaReach>();

  const collect = (reach: SchemaReach, base: Pattern, anchored: boolean): void => {
    expanding.add(reach);
    for (const at of reach.paths.values()) {
      if (at.refs.length === 0) continue;
      const fieldKeys = [...base, ...at.pattern];
      const key = patternKey(fieldKeys);
      let declared = references.get(key);
      if (!declared) {
        declared = {
          path: patternText(fieldKeys),
          fieldKeys,
          isArray: holdsItems(fieldKeys),
          kinds: [],
          entries: [],
        };
        references.set(key, declared);
      }
      for (const entry of at.refs) {
        declared.entries.push(base.length > 0 ? { ...entry, isArray: declared.isArray } : entry);
        for (const kind of entry.refs) {
          if (!declared.kinds.includes(kind)) declared.kinds.push(kind);
        }
      }
    }
    for (const stop of reach.stops.values()) {
      const path = [...base, ...stop.pattern];
      if (stop.scopes.length > 0 || stop.schemaFrom.length > 0) {
        stops.push({
          path: patternText(path),
          scopes: stop.scopes,
          schemaFrom: stop.schemaFrom,
          viaAnchor: anchored,
        });
      }
      for (const next of expansionsAt(stop, reach, schemaFrom, shapes)) {
        if (!expanding.has(next.reach)) collect(next.reach, path, anchored || next.anchor);
      }
    }
    expanding.delete(reach);
  };
  collect(reachOfSchema(schema), [], false);
  return { references: [...references.values()], stops };
}

/** An `x-telo-scope` annotation a kind's schema writes where no scope can be
 *  stood up: anywhere but a named top-level property of the resource. */
export interface MisplacedScope {
  /** Where the annotation is written in the schema (`properties.a.properties.with`). */
  location: string;
  /** Why the position is not a named top-level property. */
  reason: string;
}

/**
 * Every `x-telo-scope` annotation `schema` writes outside a named top-level
 * property — one in the root's `properties` or a root variant's `properties`,
 * written directly or through a local `$ref`. The kernel stands a scope up at
 * that one concrete site; a nested object, an array item, a map value, a
 * recursive shape, the root itself, or a node the root's reach never gets to
 * (a `$defs` entry reached only through another kind's schema-from) has none.
 */
export function misplacedScopeSlots(schema: Record<string, any>): MisplacedScope[] {
  const reach = reachOfSchema(schema);
  const recursesToRoot = [...reach.paths.values()].some((at) => at.recurse.some((to) => to.length === 0));
  const legal = new Set<object>();
  const out: MisplacedScope[] = [];
  const reported = new Set<string>();
  const report = (location: string, reason: string) => {
    if (reported.has(location)) return;
    reported.add(location);
    out.push({ location, reason });
  };
  for (const { path, node, location } of reach.scopeNodes) {
    const text = patternText(path);
    const reason =
      path.length === 0
        ? "it is the resource root itself"
        : path.some((segment) => isWildcard(segment, "{}"))
          ? `it applies to the values of an open-keyed map ('${text}')`
          : holdsItems(path)
            ? `it applies to the items of an array ('${text}')`
            : path.length > 1
              ? `it is nested under an object ('${text}')`
              : recursesToRoot
                ? "the schema refers back to its own root, so it recurs below the top level"
                : undefined;
    if (reason === undefined) legal.add(node);
    else report(location, reason);
  }
  const seen = new Set<object>();
  const scan = (value: unknown, at: string): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, i) => scan(item, `${at}[${i}]`));
      return;
    }
    const node = value as Record<string, unknown>;
    if ("x-telo-scope" in node && !legal.has(node)) {
      report(at, "no top-level property of the resource reaches it");
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "x-telo-scope") scan(child, joinKey(at, key));
    }
  };
  scan(schema, "");
  return out;
}

// --- the concrete-site enumeration -----------------------------------------

/** A reference slot at a concrete site, with where it was declared. */
export interface ReachRef {
  slot: RefSlot;
  /** The declared pattern, relative to the resource root, in its dotted
   *  spelling. */
  fieldPath: string;
  /** The same pattern as segments — exact for a key holding a dot. */
  fieldKeys: Pattern;
  /** The reach that declares the slot — the kind's own, or a schema-from
   *  anchor's — and the pattern relative to it, which is what a schema default
   *  at the slot is read against. */
  declaredIn: SchemaReach;
  declaredPath: Pattern;
  /** True when a schema-from anchor's schema declares the slot. */
  viaAnchor: boolean;
  /** The slot's `x-telo-context`, when it declares one. */
  context?: Record<string, any>;
  /** The schema node declaring the slot. */
  node: Record<string, any>;
  /** The conjunct declarations of the object enclosing the slot, in the order
   *  the reach entered them — never a branch alternative to the slot's own. */
  enclosing: readonly Record<string, any>[];
  /** The slot's value alternatives at this site: each alternative's declaration
   *  at the slot's pattern and, per union it was entered through where the slot
   *  was not, that union's member with the value at the union's position here.
   *  `members` is undefined where this site has no such position (a recursion
   *  re-entered below the union), so the alternative does not apply. */
  alternatives: readonly {
    node: Record<string, any>;
    members:
      | readonly { member: Record<string, any>; document: Record<string, any>; value: unknown }[]
      | undefined;
  }[];
}

/**
 * The schema `default:` for a pointer relative to the object enclosing a slot
 * (a `use` case map's selector), read from the enclosing object's conjunct
 * declarations in the order the reach entered them; the first default found
 * wins. Undefined when none declares one.
 */
export function enclosingDefault(ref: ReachRef, pointer: string): unknown {
  if (!pointer.startsWith("/")) return undefined;
  const segments = pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  const document = ref.declaredIn.document;
  for (const declaration of ref.enclosing) {
    let current: Record<string, any> | undefined = declaration;
    let value: unknown;
    for (const segment of segments) {
      const written: unknown = current?.properties?.[segment];
      if (!written || typeof written !== "object") {
        current = undefined;
        break;
      }
      const node = written as Record<string, any>;
      const target = typeof node.$ref === "string" ? resolveLocalReference(node, document)?.node : undefined;
      value = node.default !== undefined ? node.default : target?.default;
      current = target ?? node;
    }
    if (current && value !== undefined) return value;
  }
  return undefined;
}

/** Everything one concrete site of one resource carries, from every branch and
 *  recursion route that reaches it. */
export interface ReachSite {
  path: string;
  /** `path` as its segments — a key or an array index each — so a consumer
   *  naming something after the site never re-parses a key holding a dot. */
  keys: (string | number)[];
  data: unknown;
  /** The object or array holding `data`, and its key there — where a value
   *  written at this site is replaced in place. Absent for the resource root. */
  holder?: Record<string, unknown> | unknown[];
  key?: string | number;
  refs: ReachRef[];
  steps: StepSlot[];
  scopes: ScopeFieldEntry[];
  /** Every `x-telo-schema-from` slot at this site, expanded or not — kept only
   *  when asked for (`withSchemaFrom`). */
  schemaFrom: ReachSchemaFrom[];
}

/** An `x-telo-schema-from` slot at a concrete site. */
export interface ReachSchemaFrom {
  entry: SchemaFromFieldEntry;
  /** The declared pattern, relative to the resource root, in its dotted
   *  spelling. */
  fieldPath: string;
  fieldKeys: Pattern;
  /** The document the annotation is written in. */
  document: Record<string, any>;
  /** True when a schema-from anchor's schema writes it, not the kind's own. */
  viaAnchor: boolean;
}

/** One reference entry standing for every slot at a site: kinds unioned in
 *  declaration order, and each other fact taken from the first slot that
 *  declares it, as `readRefSlot` reads the branches of one node. */
export function siteRefEntry(site: ReachSite): RefFieldEntry {
  const first = site.refs[0]!;
  const entry: RefFieldEntry = {
    refs: [],
    uses: [],
    isArray: holdsItems(first.fieldKeys),
  };
  const valueBranches: Record<string, any>[] = [];
  for (const { slot, context } of site.refs) {
    for (const kind of slot.kinds) if (!entry.refs.includes(kind)) entry.refs.push(kind);
    for (const use of slot.uses) if (!entry.uses.includes(use)) entry.uses.push(use);
    if (slot.useCases && !entry.useCases) entry.useCases = slot.useCases;
    if (slot.inputs !== undefined && entry.inputs === undefined) entry.inputs = slot.inputs;
    if (context && !entry.context) entry.context = context;
    if (slot.inline) entry.inline = true;
    if (slot.throwsThrough) entry.throwsThrough = true;
    if (slot.outputType && !entry.outputType) entry.outputType = slot.outputType;
    if (slot.observes && !entry.observes) entry.observes = slot.observes;
    valueBranches.push(...slot.valueBranches);
  }
  if (valueBranches.length > 0) entry.valueBranches = valueBranches;
  return entry;
}

/**
 * Every concrete site of one resource, schema and data in tandem, each visited
 * once in first-reached order.
 *
 * A `{}` pattern applies only to keys its schema does not declare, and never to
 * the envelope at the resource root. A back-edge is followed as deep as the data
 * goes, guarded against data that aliases one of its own ancestors. With
 * `schemaFrom`, the anchor of a static schema-from stop is walked at each
 * concrete site of the stop, over the same data; an anchor re-entered with the
 * same value on the current descent is not walked again. With `withSchemaFrom`,
 * each concrete site of an `x-telo-schema-from` slot is a site too. With
 * `shapes`, a named shape is walked at each concrete site of the `$ref` naming
 * it, the same way.
 */
export function reachSites(
  schema: Record<string, any>,
  data: unknown,
  schemaFrom?: SchemaFromResolver,
  withSchemaFrom = false,
  shapes?: ShapeResolver,
): ReachSite[] {
  return enumerateSites(schema, data, { stops: true, schemaFrom, withSchemaFrom, shapes });
}

/** The sites through which a resource drives another — its step and reference
 *  sites, with no schema-from expansion: the reach every throws question asks
 *  over, so none can reach a slot another cannot. */
export function drivenSites(schema: Record<string, any>, data: unknown): ReachSite[] {
  return enumerateSites(schema, data, { stops: false });
}

interface SiteOptions {
  /** Keep scope sites. */
  stops: boolean;
  /** Keep schema-from sites too. */
  withSchemaFrom?: boolean;
  schemaFrom?: SchemaFromResolver;
  shapes?: ShapeResolver;
}

function enumerateSites(
  schema: Record<string, any>,
  data: unknown,
  { stops: keepStops, withSchemaFrom, schemaFrom, shapes }: SiteOptions,
): ReachSite[] {
  if (data === undefined || data === null) return [];
  const root = reachOfSchema(schema);
  const followsStops = keepStops || schemaFrom !== undefined || shapes !== undefined;
  if (!root.drives && !(followsStops && root.stops.size > 0)) return [];
  const sites = new Map<string, ReachSite & { from: Set<object> }>();
  const onData = new Set<unknown>([data]);
  const expanded = new Map<unknown, Set<SchemaReach>>();

  const siteAt = (path: string, keys: (string | number)[], found: Site) => {
    const id = JSON.stringify(keys);
    let site = sites.get(id);
    if (!site) {
      site = {
        path,
        keys,
        data: found.value,
        refs: [],
        steps: [],
        scopes: [],
        schemaFrom: [],
        from: new Set(),
      };
      if (found.holder) {
        site.holder = found.holder;
        site.key = found.key;
      }
      sites.set(id, site);
    }
    return site;
  };

  const walk = (
    reach: SchemaReach,
    prefix: Pattern,
    at0: Site,
    base: string,
    baseKeys: (string | number)[],
    patternBase: Pattern,
    anchored: boolean,
  ): void => {
    for (const at of reach.paths.values()) {
      const declaredPath = at.pattern;
      const rel = relativeFieldPath(declaredPath, prefix);
      if (rel === undefined) continue;
      for (const found of resolveSites(at0, rel, prefix, reach)) {
        const path = joinConcrete(base, found.path);
        const keys = [...baseKeys, ...found.keys];
        if (at.steps.length > 0 || at.refs.length > 0) {
          const site = siteAt(path, keys, found);
          for (const step of at.steps) {
            if (site.from.has(step)) continue;
            site.from.add(step);
            site.steps.push(step);
          }
          for (const entry of at.refs) {
            if (site.from.has(entry)) continue;
            site.from.add(entry);
            const fieldKeys = [...patternBase, ...declaredPath];
            const ref: ReachRef = {
              slot: refSlotOfEntry(entry),
              fieldPath: patternText(fieldKeys),
              fieldKeys,
              declaredIn: reach,
              declaredPath,
              viaAnchor: anchored,
              node: entryDeclarations.get(entry)!.node,
              enclosing: enclosingDeclarations(reach, declaredPath, entry),
              alternatives: siteAlternatives(entry, reach, prefix, at0, found),
            };
            if (entry.context) ref.context = entry.context;
            site.refs.push(ref);
          }
        }
        if (at.recurse.length === 0) continue;
        if (!found.value || typeof found.value !== "object" || onData.has(found.value)) continue;
        onData.add(found.value);
        for (const to of at.recurse) walk(reach, to, found, path, keys, patternBase, anchored);
        onData.delete(found.value);
      }
    }
    if (!followsStops || reach.stops.size === 0) return;
    for (const stop of reach.stops.values()) {
      const declaredPath = stop.pattern;
      const rel = relativeFieldPath(declaredPath, prefix);
      if (rel === undefined) continue;
      for (const found of resolveSites(at0, rel, prefix, reach)) {
        const path = joinConcrete(base, found.path);
        const keys = [...baseKeys, ...found.keys];
        if (keepStops && (stop.scopes.length > 0 || (withSchemaFrom && stop.schemaFrom.length > 0))) {
          const site = siteAt(path, keys, found);
          for (const scope of stop.scopes) {
            if (site.from.has(scope)) continue;
            site.from.add(scope);
            site.scopes.push(scope);
          }
          for (const entry of withSchemaFrom ? stop.schemaFrom : []) {
            if (site.from.has(entry)) continue;
            site.from.add(entry);
            const fieldKeys = [...patternBase, ...declaredPath];
            site.schemaFrom.push({
              entry,
              fieldPath: patternText(fieldKeys),
              fieldKeys,
              document: reach.document,
              viaAnchor: anchored,
            });
          }
        }
        for (const next of expansionsAt(stop, reach, schemaFrom, shapes)) {
          let entered = expanded.get(found.value);
          if (!entered) expanded.set(found.value, (entered = new Set()));
          if (entered.has(next.reach)) continue;
          entered.add(next.reach);
          walk(
            next.reach,
            [],
            found,
            path,
            keys,
            [...patternBase, ...declaredPath],
            anchored || next.anchor,
          );
          entered.delete(next.reach);
        }
      }
    }
  };
  walk(root, [], { value: data, path: "", keys: [] }, "", [], [], false);

  return [...sites.values()].map(({ from, ...site }) => site);
}

/** An entry's value alternatives at one concrete site `found` below `start`,
 *  each union member paired with the value at the union's position — the site's
 *  own ancestor there, among the positions the union's pattern resolves to. */
function siteAlternatives(
  entry: RefFieldEntry,
  reach: SchemaReach,
  prefix: Pattern,
  start: Site,
  found: Site,
): ReachRef["alternatives"] {
  const declared = entryAlternatives.get(entry);
  if (!declared) return [];
  return declared.map(({ node, diverging }) => {
    const members: { member: Record<string, any>; document: Record<string, any>; value: unknown }[] = [];
    for (const choice of diverging) {
      const rel = samePattern(choice.path, prefix) ? [] : relativeFieldPath(choice.path, prefix);
      const position =
        rel === undefined
          ? undefined
          : resolveSites(start, rel, prefix, reach).find(
              (site) =>
                site.keys.length <= found.keys.length &&
                site.keys.every((key, i) => found.keys[i] === key),
            );
      if (!position) return { node, members: undefined };
      members.push({ member: unionMember(choice), document: reach.document, value: position.value });
    }
    return { node, members };
  });
}

/** A concrete position of a resource at or above a reference slot. */
export interface ReachPosition {
  path: string;
  value: unknown;
  /** The declared pattern of a slot the position leads to (or is), in its
   *  dotted spelling. */
  fieldPath: string;
  /** The same pattern as segments — exact for a key holding a dot. */
  fieldKeys: Pattern;
}

/**
 * Every concrete position of a resource at or ABOVE one of its reference
 * slots — the slot itself, and each container on the way to it — recursion
 * unrolled as deep as the data goes (with the same ancestor-alias guard as
 * {@link reachSites}) and, with `schemaFrom` / `shapes`, static schema-from
 * slots and named shapes expanded.
 * What a value written ABOVE a slot is asked about: an expression there leaves
 * no concrete site below it, yet it holds the slot's value.
 */
export function reachPositions(
  schema: Record<string, any>,
  data: unknown,
  schemaFrom?: SchemaFromResolver,
  shapes?: ShapeResolver,
): ReachPosition[] {
  if (data === undefined || data === null) return [];
  const root = reachOfSchema(schema);
  const positions = new Map<string, ReachPosition>();
  const onData = new Set<unknown>([data]);
  const expanded = new Map<unknown, Set<SchemaReach>>();

  const emit = (
    reach: SchemaReach,
    prefix: Pattern,
    at0: Site,
    base: string,
    baseKeys: (string | number)[],
    rel: Pattern,
    fieldKeys: Pattern,
  ) => {
    for (const relPrefix of patternPrefixes(rel)) {
      for (const found of resolveSites(at0, relPrefix, prefix, reach)) {
        const id = JSON.stringify([...baseKeys, ...found.keys]);
        if (positions.has(id)) continue;
        positions.set(id, {
          path: joinConcrete(base, found.path),
          value: found.value,
          fieldPath: patternText(fieldKeys),
          fieldKeys,
        });
      }
    }
  };

  const walk = (
    reach: SchemaReach,
    prefix: Pattern,
    at0: Site,
    base: string,
    baseKeys: (string | number)[],
    patternBase: Pattern,
  ): void => {
    for (const at of reach.paths.values()) {
      if (at.refs.length === 0 && at.recurse.length === 0) continue;
      const declaredPath = at.pattern;
      const rel = relativeFieldPath(declaredPath, prefix);
      if (rel === undefined) continue;
      // A back-edge's position leads to the slots below the node it re-enters.
      const leadsTo =
        at.refs.length > 0
          ? declaredPath
          : [...reach.paths.values()].find(
              (below) =>
                below.refs.length > 0 &&
                at.recurse.some((to) => relativeFieldPath(below.pattern, to) !== undefined),
            )?.pattern;
      if (leadsTo !== undefined) emit(reach, prefix, at0, base, baseKeys, rel, [...patternBase, ...leadsTo]);
      if (at.recurse.length === 0) continue;
      for (const found of resolveSites(at0, rel, prefix, reach)) {
        if (!found.value || typeof found.value !== "object" || onData.has(found.value)) continue;
        onData.add(found.value);
        const path = joinConcrete(base, found.path);
        const keys = [...baseKeys, ...found.keys];
        for (const to of at.recurse) walk(reach, to, found, path, keys, patternBase);
        onData.delete(found.value);
      }
    }
    if (!schemaFrom && !shapes) return;
    for (const stop of reach.stops.values()) {
      const declaredPath = stop.pattern;
      const rel = relativeFieldPath(declaredPath, prefix);
      if (rel === undefined) continue;
      for (const { reach: anchored, anchor } of expansionsAt(stop, reach, schemaFrom, shapes)) {
        if (!leadsToSlot(anchored, schemaFrom, shapes)) continue;
        // A named shape is part of the schema that names it, so the position
        // above it leads to the first slot the shape declares.
        const firstSlot = anchor
          ? undefined
          : [...anchored.paths.values()].find((at) => at.refs.length > 0)?.pattern;
        const anchoredBase = [...patternBase, ...declaredPath];
        // Emitted with or without a concrete site at the stop: a value computed
        // above it leaves none, yet holds the slot's value.
        emit(reach, prefix, at0, base, baseKeys, rel, [...anchoredBase, ...(firstSlot ?? [])]);
        for (const found of resolveSites(at0, rel, prefix, reach)) {
          let entered = expanded.get(found.value);
          if (!entered) expanded.set(found.value, (entered = new Set()));
          if (entered.has(anchored)) continue;
          entered.add(anchored);
          walk(
            anchored,
            [],
            found,
            joinConcrete(base, found.path),
            [...baseKeys, ...found.keys],
            anchoredBase,
          );
          entered.delete(anchored);
        }
      }
    }
  };
  walk(root, [], { value: data, path: "", keys: [] }, "", [], []);
  return [...positions.values()];
}

/** True when `reach`, or a reach one of its stops hands off to, holds a step or
 *  reference slot. */
function leadsToSlot(
  reach: SchemaReach,
  schemaFrom: SchemaFromResolver | undefined,
  shapes: ShapeResolver | undefined,
  seen: Set<SchemaReach> = new Set(),
): boolean {
  if (reach.drives) return true;
  if (seen.has(reach)) return false;
  seen.add(reach);
  for (const stop of reach.stops.values()) {
    for (const next of expansionsAt(stop, reach, schemaFrom, shapes)) {
      if (leadsToSlot(next.reach, schemaFrom, shapes, seen)) return true;
    }
  }
  return false;
}

/** Every non-empty prefix of a relative pattern, one per step a walk takes:
 *  `a.b[].c` → `a`, `a.b`, `a.b[]`, `a.b[].c`. */
function patternPrefixes(rel: Pattern): Pattern[] {
  const out: Pattern[] = [];
  for (let i = 1; i <= rel.length; i++) out.push(rel.slice(0, i));
  return out;
}

interface Site {
  value: unknown;
  path: string;
  keys: (string | number)[];
  holder?: Record<string, unknown> | unknown[];
  key?: string | number;
}

/** The values at `rel` below `start`, where `rel` is relative to the pattern
 *  `prefix`. A `{}` segment skips the keys the reach records as declared for
 *  that pattern; each `[]` iterates one array level; any other segment is one
 *  property name, read as written. Paths are relative to `start`. */
function resolveSites(start: Site, rel: Pattern, prefix: Pattern, reach: SchemaReach): Site[] {
  let sites: Site[] = [{ ...start, path: "", keys: [] }];
  const field: PatternSegment[] = [...prefix];
  for (const segment of rel) {
    field.push(segment);
    const next: Site[] = [];
    if (typeof segment === "string") {
      for (const site of sites) {
        if (!site.value || typeof site.value !== "object") continue;
        const entry = (site.value as Record<string, unknown>)[segment];
        if (entry == null) continue;
        next.push({
          value: entry,
          path: joinKey(site.path, segment),
          keys: [...site.keys, segment],
          holder: site.value as Record<string, unknown>,
          key: segment,
        });
      }
    } else if (segment.wildcard === "{}") {
      const declared = reach.declaredKeys.get(patternKey(field));
      for (const site of sites) {
        if (!site.value || typeof site.value !== "object" || Array.isArray(site.value)) continue;
        for (const [key, entry] of Object.entries(site.value as Record<string, unknown>)) {
          if (entry == null || declared?.has(key)) continue;
          next.push({
            value: entry,
            path: joinKey(site.path, key),
            keys: [...site.keys, key],
            holder: site.value as Record<string, unknown>,
            key,
          });
        }
      }
    } else {
      for (const holder of sites) {
        if (!Array.isArray(holder.value)) continue;
        const array = holder.value;
        array.forEach((item, i) => {
          if (item != null) {
            next.push({
              value: item,
              path: `${holder.path}[${i}]`,
              keys: [...holder.keys, i],
              holder: array,
              key: i,
            });
          }
        });
      }
    }
    sites = next;
  }
  return sites;
}

/** `pattern` relative to `prefix`, or undefined when it is not strictly below
 *  it. A result starting `[]` iterates the value at `prefix` itself. */
function relativeFieldPath(pattern: Pattern, prefix: Pattern): Pattern | undefined {
  if (prefix.length === 0) return pattern;
  if (pattern.length <= prefix.length) return undefined;
  for (let i = 0; i < prefix.length; i++) {
    if (!sameSegment(pattern[i]!, prefix[i]!)) return undefined;
  }
  return pattern.slice(prefix.length);
}

/** A concrete path `rel` below `base`, in the dotted display spelling. */
function joinConcrete(base: string, rel: string): string {
  if (!base) return rel;
  if (!rel) return base;
  return rel.startsWith("[") ? `${base}${rel}` : `${base}.${rel}`;
}

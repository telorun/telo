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
 * - a non-local `$ref` is never followed ({@link resolveLocalReference} is the
 *   one place that decides, so widening it is a resolver change);
 * - a pattern keeps EVERY slot any branch declares there.
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
import { resolveSchemaPointer } from "./manifest-navigation.js";
import { readRefSlot, type RefSlot } from "./ref-slot.js";
import { readStepSlot, type StepSlot } from "./step-slot.js";
import type {
  RefFieldEntry,
  SchemaFromFieldEntry,
  ScopeFieldEntry,
} from "./reference-field-map.js";

/** Everything the traversal records at one pattern that drives another. */
export interface ReachPath {
  /** Every reference slot declared here, by any branch. */
  refs: RefFieldEntry[];
  /** Every step body declared here, by any branch. */
  steps: StepSlot[];
  /** Back-edges of a recursive schema: the node here is also the one entered at
   *  each of these patterns, so everything below them applies again below this
   *  one, as deep as a resource's data goes. */
  recurse: string[];
}

/** The stops recorded at one pattern: where the traversal hands off. */
export interface ReachStop {
  scopes: ScopeFieldEntry[];
  schemaFrom: SchemaFromFieldEntry[];
}

/** One schema's reach, entered at `node` and resolving `$ref` against `document`. */
export interface SchemaReach {
  document: Record<string, any>;
  node: Record<string, any>;
  /** Patterns (`routes[].handler`, `content.{}.encoder`) relative to `node`. */
  paths: Map<string, ReachPath>;
  stops: Map<string, ReachStop>;
  /** Per `{}` pattern, the keys its `additionalProperties` does not apply to:
   *  those the same schema declares under `properties`, plus the resource
   *  envelope at a resource root. Where several schemas meet at one `{}`
   *  pattern, only keys every one of them declares are skipped. */
  declaredKeys: Map<string, Set<string>>;
  /** True when some pattern holds a step or reference slot. */
  drives: boolean;
  /** Every `x-telo-scope` node reached, with the pattern it applies at and
   *  where it is written in `document` (`properties.with`, `$defs.With`). */
  scopeNodes: ScopeNode[];
}

export interface ScopeNode {
  path: string;
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
  path: string,
): RefFieldEntry {
  const entry: RefFieldEntry = {
    refs: slot.kinds,
    uses: slot.uses,
    isArray: path.includes("[]"),
  };
  if (slot.useCases) entry.useCases = slot.useCases;
  if (slot.inputs !== undefined) entry.inputs = slot.inputs;
  if (slot.valueBranches.length > 0) entry.valueBranches = slot.valueBranches;
  if (node["x-telo-context"]) entry.context = node["x-telo-context"] as Record<string, any>;
  if (slot.inline) entry.inline = true;
  if (slot.throwsThrough) entry.throwsThrough = true;
  if (slot.outputType) entry.outputType = slot.outputType;
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
  return slot;
}

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
  /** Per pattern, the schema nodes already recorded there: one node reached
   *  twice at one pattern (two branches `$ref`-ing one definition) is one slot. */
  recorded: Map<string, Set<object>>;
  /** Each node on the current descent, with the pattern it was entered at. */
  onStack: Map<object, string>;
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
  };
  const walk: Walk = { reach, envelope, recorded: new Map(), onStack: new Map([[node, ""]]) };
  visitNode(node, "", locationIn(document, node), walk);
  return reach;
}

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

function firstTime(walk: Walk, path: string, node: object): boolean {
  let nodes = walk.recorded.get(path);
  if (!nodes) walk.recorded.set(path, (nodes = new Set()));
  if (nodes.has(node)) return false;
  nodes.add(node);
  return true;
}

function pathAt(walk: Walk, path: string): ReachPath {
  let entry = walk.reach.paths.get(path);
  if (!entry) walk.reach.paths.set(path, (entry = { refs: [], steps: [], recurse: [] }));
  return entry;
}

function stopAt(walk: Walk, path: string): ReachStop {
  let entry = walk.reach.stops.get(path);
  if (!entry) walk.reach.stops.set(path, (entry = { scopes: [], schemaFrom: [] }));
  return entry;
}

function visitNode(node: unknown, path: string, loc: string, walk: Walk): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const schema = node as Record<string, any>;
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
      visitNode(schema.items, `${path}[]`, joinKey(loc, "items"), walk);
    }
    return;
  }
  const slot = readRefSlot(schema);
  if (slot && slot.kinds.length > 0) {
    if (firstTime(walk, path, schema)) {
      pathAt(walk, path).refs.push(refFieldEntryOf(slot, schema, path));
      walk.reach.drives = true;
    }
    // A slot's branches may be object shapes carrying their OWN nested slots
    // (Application `targets`: a bare ref vs an inline `{ invoke }`).
    visitVariants(schema, path, loc, walk);
    return;
  }
  if (typeof schema.$ref === "string") {
    followLocalRef(schema, path, walk);
    return;
  }
  if (schema.type === "array" && schema.items) {
    visitNode(schema.items, `${path}[]`, joinKey(loc, "items"), walk);
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

function visitProperties(schema: Record<string, any>, path: string, loc: string, walk: Walk): void {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object") return;
  for (const [key, propSchema] of Object.entries(properties)) {
    visitNode(propSchema, joinKey(path, key), joinKey(joinKey(loc, "properties"), key), walk);
  }
}

function visitVariants(schema: Record<string, any>, path: string, loc: string, walk: Walk): void {
  for (const variantKey of ["oneOf", "anyOf", "allOf"] as const) {
    const variants = schema[variantKey];
    if (!Array.isArray(variants)) continue;
    variants.forEach((variant, i) => {
      if (variant && typeof variant === "object") {
        visitVariant(variant, path, `${joinKey(loc, variantKey)}[${i}]`, walk);
      }
    });
  }
}

/** One branch of a union. Its own root is not a slot — `readRefSlot` already
 *  unioned an `anyOf` of reference branches at the parent — so only what lies
 *  below it is walked, and a `$ref` branch is followed as a node of its own. */
function visitVariant(variant: Record<string, any>, path: string, loc: string, walk: Walk): void {
  if (typeof variant.$ref === "string") {
    followLocalRef(variant, path, walk);
    return;
  }
  visitProperties(variant, path, loc, walk);
  if (variant.type === "array" && variant.items) {
    visitNode(variant.items, `${path}[]`, joinKey(loc, "items"), walk);
  }
  visitMapValue(variant, path, loc, walk);
}

/** A reference to a node already on the descent records a back-edge to the
 *  pattern it was entered at; a cycle that made no structural progress (same
 *  pattern) records nothing, since its body is already recorded there. */
function followLocalRef(node: Record<string, any>, path: string, walk: Walk): void {
  const target = resolveLocalReference(node, walk.reach.document);
  if (!target || target.node === node) return;
  const entered = walk.onStack.get(target.node);
  if (entered !== undefined) {
    if (entered !== path) {
      const at = pathAt(walk, path);
      if (!at.recurse.includes(entered)) at.recurse.push(entered);
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

function visitMapValue(owner: Record<string, any>, path: string, loc: string, walk: Walk): void {
  const valueSchema = owner.additionalProperties;
  if (!valueSchema || typeof valueSchema !== "object" || Array.isArray(valueSchema)) return;
  const mapPath = joinKey(path, "{}");
  const declared =
    owner.properties && typeof owner.properties === "object" ? Object.keys(owner.properties) : [];
  if (path === "" && walk.envelope) declared.push(...RESOURCE_ENVELOPE_KEYS);
  const previous = walk.reach.declaredKeys.get(mapPath);
  walk.reach.declaredKeys.set(
    mapPath,
    new Set(previous ? declared.filter((key) => previous.has(key)) : declared),
  );
  visitNode(valueSchema, mapPath, joinKey(loc, "additionalProperties"), walk);
}

// --- the declared-slot view -------------------------------------------------

/** A reference pattern a kind's schema declares, with every slot any branch
 *  declares there. */
export interface DeclaredReference {
  /** The pattern, relative to the resource root. */
  path: string;
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
  /** True when a schema-from anchor's schema declares it, not the kind's own. */
  viaAnchor: boolean;
}

export interface DeclaredReach {
  references: DeclaredReference[];
  stops: DeclaredStop[];
}

/**
 * The patterns a kind's schema declares. A recursive slot's pattern is its
 * outermost occurrence. With `schemaFrom`, a static schema-from stop also
 * contributes the patterns of its anchor, rooted at the stop's pattern; a chain
 * of anchors leading back to one already being expanded stops there.
 */
export function declaredReach(
  schema: Record<string, any>,
  schemaFrom?: SchemaFromResolver,
): DeclaredReach {
  const references = new Map<string, DeclaredReference>();
  const stops: DeclaredStop[] = [];
  const expanding = new Set<SchemaReach>();

  const collect = (reach: SchemaReach, base: string): void => {
    expanding.add(reach);
    for (const [rel, at] of reach.paths) {
      if (at.refs.length === 0) continue;
      const path = joinPattern(base, rel);
      let declared = references.get(path);
      if (!declared) {
        declared = { path, isArray: path.includes("[]"), kinds: [], entries: [] };
        references.set(path, declared);
      }
      for (const entry of at.refs) {
        declared.entries.push(base ? { ...entry, isArray: declared.isArray } : entry);
        for (const kind of entry.refs) {
          if (!declared.kinds.includes(kind)) declared.kinds.push(kind);
        }
      }
    }
    for (const [rel, stop] of reach.stops) {
      const path = joinPattern(base, rel);
      stops.push({ path, scopes: stop.scopes, schemaFrom: stop.schemaFrom, viaAnchor: base !== "" });
      if (!schemaFrom) continue;
      for (const { schemaFrom: expression } of stop.schemaFrom) {
        const anchor = schemaFrom(expression, reach.document);
        if (!anchor) continue;
        const anchored = reachOfNode(anchor.document, anchor.node);
        if (!expanding.has(anchored)) collect(anchored, path);
      }
    }
    expanding.delete(reach);
  };
  collect(reachOfSchema(schema), "");
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
  const recursesToRoot = [...reach.paths.values()].some((at) => at.recurse.includes(""));
  const legal = new Set<object>();
  const out: MisplacedScope[] = [];
  const reported = new Set<string>();
  const report = (location: string, reason: string) => {
    if (reported.has(location)) return;
    reported.add(location);
    out.push({ location, reason });
  };
  for (const { path, node, location } of reach.scopeNodes) {
    const reason =
      path === ""
        ? "it is the resource root itself"
        : path.includes("{}")
          ? `it applies to the values of an open-keyed map ('${path}')`
          : path.includes("[]")
            ? `it applies to the items of an array ('${path}')`
            : path.includes(".")
              ? `it is nested under an object ('${path}')`
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
  /** The declared pattern, relative to the resource root. */
  fieldPath: string;
  /** The reach that declares the slot — the kind's own, or a schema-from
   *  anchor's — and the pattern relative to it, which is what a schema default
   *  at the slot is read against. */
  declaredIn: SchemaReach;
  declaredPath: string;
  /** True when a schema-from anchor's schema declares the slot. */
  viaAnchor: boolean;
  /** The slot's `x-telo-context`, when it declares one. */
  context?: Record<string, any>;
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
  /** The declared pattern, relative to the resource root. */
  fieldPath: string;
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
    isArray: first.fieldPath.includes("[]"),
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
 * each concrete site of an `x-telo-schema-from` slot is a site too.
 */
export function reachSites(
  schema: Record<string, any>,
  data: unknown,
  schemaFrom?: SchemaFromResolver,
  withSchemaFrom = false,
): ReachSite[] {
  return enumerateSites(schema, data, { stops: true, schemaFrom, withSchemaFrom });
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
}

function enumerateSites(
  schema: Record<string, any>,
  data: unknown,
  { stops: keepStops, withSchemaFrom, schemaFrom }: SiteOptions,
): ReachSite[] {
  if (data === undefined || data === null) return [];
  const root = reachOfSchema(schema);
  const followsStops = keepStops || schemaFrom !== undefined;
  if (!root.drives && !(followsStops && root.stops.size > 0)) return [];
  const sites = new Map<string, ReachSite & { from: Set<object> }>();
  const onData = new Set<unknown>([data]);
  const expanded = new Map<unknown, Set<SchemaReach>>();

  const siteAt = (path: string, keys: (string | number)[], found: Site) => {
    let site = sites.get(path);
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
      sites.set(path, site);
    }
    return site;
  };

  const walk = (
    reach: SchemaReach,
    prefix: string,
    at0: Site,
    base: string,
    baseKeys: (string | number)[],
    patternBase: string,
  ): void => {
    for (const [declaredPath, at] of reach.paths) {
      const rel = relativeFieldPath(declaredPath, prefix);
      if (rel === undefined) continue;
      for (const found of resolveSites(at0, rel, prefix, reach)) {
        const path = joinPattern(base, found.path);
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
            const ref: ReachRef = {
              slot: refSlotOfEntry(entry),
              fieldPath: joinPattern(patternBase, declaredPath),
              declaredIn: reach,
              declaredPath,
              viaAnchor: reach !== root,
            };
            if (entry.context) ref.context = entry.context;
            site.refs.push(ref);
          }
        }
        if (at.recurse.length === 0) continue;
        if (!found.value || typeof found.value !== "object" || onData.has(found.value)) continue;
        onData.add(found.value);
        for (const to of at.recurse) walk(reach, to, found, path, keys, patternBase);
        onData.delete(found.value);
      }
    }
    if (!followsStops || reach.stops.size === 0) return;
    for (const [declaredPath, stop] of reach.stops) {
      const rel = relativeFieldPath(declaredPath, prefix);
      if (rel === undefined) continue;
      for (const found of resolveSites(at0, rel, prefix, reach)) {
        const path = joinPattern(base, found.path);
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
            site.schemaFrom.push({
              entry,
              fieldPath: joinPattern(patternBase, declaredPath),
              document: reach.document,
              viaAnchor: reach !== root,
            });
          }
        }
        if (!schemaFrom) continue;
        for (const { schemaFrom: expression } of stop.schemaFrom) {
          const anchor = schemaFrom(expression, reach.document);
          if (!anchor) continue;
          const anchored = reachOfNode(anchor.document, anchor.node);
          let entered = expanded.get(found.value);
          if (!entered) expanded.set(found.value, (entered = new Set()));
          if (entered.has(anchored)) continue;
          entered.add(anchored);
          walk(anchored, "", found, path, keys, joinPattern(patternBase, declaredPath));
          entered.delete(anchored);
        }
      }
    }
  };
  walk(root, "", { value: data, path: "", keys: [] }, "", [], "");

  return [...sites.values()].map(({ from, ...site }) => site);
}

/** A concrete position of a resource at or above a reference slot. */
export interface ReachPosition {
  path: string;
  value: unknown;
  /** The declared pattern of a slot the position leads to (or is). */
  fieldPath: string;
}

/**
 * Every concrete position of a resource at or ABOVE one of its reference
 * slots — the slot itself, and each container on the way to it — recursion
 * unrolled as deep as the data goes (with the same ancestor-alias guard as
 * {@link reachSites}) and, with `schemaFrom`, static schema-from slots expanded.
 * What a value written ABOVE a slot is asked about: an expression there leaves
 * no concrete site below it, yet it holds the slot's value.
 */
export function reachPositions(
  schema: Record<string, any>,
  data: unknown,
  schemaFrom?: SchemaFromResolver,
): ReachPosition[] {
  if (data === undefined || data === null) return [];
  const root = reachOfSchema(schema);
  const positions = new Map<string, ReachPosition>();
  const onData = new Set<unknown>([data]);
  const expanded = new Map<unknown, Set<SchemaReach>>();

  const emit = (reach: SchemaReach, prefix: string, at0: Site, base: string, rel: string, fieldPath: string) => {
    for (const relPrefix of patternPrefixes(rel)) {
      for (const found of resolveSites(at0, relPrefix, prefix, reach)) {
        const path = joinPattern(base, found.path);
        if (!positions.has(path)) positions.set(path, { path, value: found.value, fieldPath });
      }
    }
  };

  const walk = (reach: SchemaReach, prefix: string, at0: Site, base: string, patternBase: string): void => {
    for (const [declaredPath, at] of reach.paths) {
      if (at.refs.length === 0 && at.recurse.length === 0) continue;
      const rel = relativeFieldPath(declaredPath, prefix);
      if (rel === undefined) continue;
      // A back-edge's position leads to the slots below the node it re-enters.
      const leadsTo =
        at.refs.length > 0
          ? declaredPath
          : [...reach.paths].find(
              ([pattern, below]) =>
                below.refs.length > 0 && at.recurse.some((to) => relativeFieldPath(pattern, to) !== undefined),
            )?.[0];
      if (leadsTo !== undefined) emit(reach, prefix, at0, base, rel, joinPattern(patternBase, leadsTo));
      if (at.recurse.length === 0) continue;
      for (const found of resolveSites(at0, rel, prefix, reach)) {
        if (!found.value || typeof found.value !== "object" || onData.has(found.value)) continue;
        onData.add(found.value);
        const path = joinPattern(base, found.path);
        for (const to of at.recurse) walk(reach, to, found, path, patternBase);
        onData.delete(found.value);
      }
    }
    if (!schemaFrom) return;
    for (const [declaredPath, stop] of reach.stops) {
      const rel = relativeFieldPath(declaredPath, prefix);
      if (rel === undefined) continue;
      for (const { schemaFrom: expression } of stop.schemaFrom) {
        const anchor = schemaFrom(expression, reach.document);
        if (!anchor) continue;
        const anchored = reachOfNode(anchor.document, anchor.node);
        if (!anchored.drives) continue;
        for (const found of resolveSites(at0, rel, prefix, reach)) {
          let entered = expanded.get(found.value);
          if (!entered) expanded.set(found.value, (entered = new Set()));
          if (entered.has(anchored)) continue;
          entered.add(anchored);
          const path = joinPattern(base, found.path);
          const anchoredBase = joinPattern(patternBase, declaredPath);
          emit(reach, prefix, at0, base, rel, anchoredBase);
          walk(anchored, "", found, path, anchoredBase);
          entered.delete(anchored);
        }
      }
    }
  };
  walk(root, "", { value: data, path: "", keys: [] }, "", "");
  return [...positions.values()];
}

/** Every non-empty prefix of a relative pattern, one per step a walk takes:
 *  `a.b[].c` → `a`, `a.b`, `a.b[]`, `a.b[].c`. */
function patternPrefixes(rel: string): string[] {
  const out: string[] = [];
  let acc = "";
  for (const part of rel.split(".")) {
    if (part === "") continue;
    const key = part.replace(/(\[\])+$/, "");
    if (key) out.push((acc = joinKey(acc, key)));
    for (let d = 0; d < (part.length - key.length) / 2; d++) out.push((acc = `${acc}[]`));
  }
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
 *  that pattern; each `[]` iterates one array level. Paths are relative to
 *  `start`. */
function resolveSites(start: Site, rel: string, prefix: string, reach: SchemaReach): Site[] {
  let sites: Site[] = [{ ...start, path: "", keys: [] }];
  if (rel === "") return sites;
  let field = prefix;
  for (const part of rel.split(".")) {
    const next: Site[] = [];
    if (part === "{}") {
      field = joinKey(field, "{}");
      const declared = reach.declaredKeys.get(field);
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
      const key = part.replace(/(\[\])+$/, "");
      const depth = (part.length - key.length) / 2;
      field = key ? joinKey(field, part) : `${field}${part}`;
      for (const site of sites) {
        let level: Site[];
        if (key) {
          if (!site.value || typeof site.value !== "object") continue;
          const entry = (site.value as Record<string, unknown>)[key];
          if (entry == null) continue;
          level = [
            {
              value: entry,
              path: joinKey(site.path, key),
              keys: [...site.keys, key],
              holder: site.value as Record<string, unknown>,
              key,
            },
          ];
        } else {
          level = [site];
        }
        for (let d = 0; d < depth; d++) {
          const items: Site[] = [];
          for (const holder of level) {
            if (!Array.isArray(holder.value)) continue;
            const array = holder.value;
            array.forEach((item, i) => {
              if (item != null) {
                items.push({
                  value: item,
                  path: `${holder.path}[${i}]`,
                  keys: [...holder.keys, i],
                  holder: array,
                  key: i,
                });
              }
            });
          }
          level = items;
        }
        next.push(...level);
      }
    }
    sites = next;
  }
  return sites;
}

/** `pattern` relative to `prefix`, or undefined when it is not strictly below
 *  it. A result starting `[]` iterates the value at `prefix` itself. */
function relativeFieldPath(pattern: string, prefix: string): string | undefined {
  if (prefix === "") return pattern;
  if (pattern.startsWith(`${prefix}.`)) return pattern.slice(prefix.length + 1);
  if (pattern.startsWith(`${prefix}[]`)) return pattern.slice(prefix.length);
  return undefined;
}

/** `rel` below `base`, for concrete paths and patterns alike. */
function joinPattern(base: string, rel: string): string {
  if (!base) return rel;
  if (!rel) return base;
  return rel.startsWith("[") ? `${base}${rel}` : `${base}.${rel}`;
}

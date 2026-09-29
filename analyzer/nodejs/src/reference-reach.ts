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
 * - it stops at `x-telo-scope`, at `x-telo-schema-from` and at a step body;
 * - a non-local `$ref` is never followed ({@link resolveLocalReference} is the
 *   one place that decides, so widening it is a resolver change);
 * - a pattern keeps EVERY slot any branch declares there.
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
  };
  const walk: Walk = { reach, envelope, recorded: new Map(), onStack: new Map([[node, ""]]) };
  visitNode(node, "", walk);
  return reach;
}

const joinKey = (path: string, key: string): string => (path ? `${path}.${key}` : key);

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

function visitNode(node: unknown, path: string, walk: Walk): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const schema = node as Record<string, any>;
  if ("x-telo-scope" in schema) {
    if (firstTime(walk, path, schema)) {
      stopAt(walk, path).scopes.push({ scope: schema["x-telo-scope"] });
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
    visitVariants(schema, path, walk);
    return;
  }
  if (typeof schema.$ref === "string") {
    followLocalRef(schema, path, walk);
    return;
  }
  if (schema.type === "array" && schema.items) visitNode(schema.items, `${path}[]`, walk);
  visitProperties(schema, path, walk);
  visitVariants(schema, path, walk);
  visitMapValue(schema, path, walk);
}

function visitProperties(schema: Record<string, any>, path: string, walk: Walk): void {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object") return;
  for (const [key, propSchema] of Object.entries(properties)) {
    visitNode(propSchema, joinKey(path, key), walk);
  }
}

function visitVariants(schema: Record<string, any>, path: string, walk: Walk): void {
  for (const variantKey of ["oneOf", "anyOf", "allOf"] as const) {
    const variants = schema[variantKey];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      if (variant && typeof variant === "object") visitVariant(variant, path, walk);
    }
  }
}

/** One branch of a union. Its own root is not a slot — `readRefSlot` already
 *  unioned an `anyOf` of reference branches at the parent — so only what lies
 *  below it is walked, and a `$ref` branch is followed as a node of its own. */
function visitVariant(variant: Record<string, any>, path: string, walk: Walk): void {
  if (typeof variant.$ref === "string") {
    followLocalRef(variant, path, walk);
    return;
  }
  visitProperties(variant, path, walk);
  if (variant.type === "array" && variant.items) visitNode(variant.items, `${path}[]`, walk);
  visitMapValue(variant, path, walk);
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
    visitNode(target.node, path, walk);
  } finally {
    walk.onStack.delete(target.node);
  }
}

function visitMapValue(owner: Record<string, any>, path: string, walk: Walk): void {
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
  visitNode(valueSchema, mapPath, walk);
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
      stops.push({ path, scopes: stop.scopes, schemaFrom: stop.schemaFrom });
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
}

/** Everything one concrete site of one resource carries, from every branch and
 *  recursion route that reaches it. */
export interface ReachSite {
  path: string;
  data: unknown;
  refs: ReachRef[];
  steps: StepSlot[];
  scopes: ScopeFieldEntry[];
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
 * same value on the current descent is not walked again.
 */
export function reachSites(
  schema: Record<string, any>,
  data: unknown,
  schemaFrom?: SchemaFromResolver,
): ReachSite[] {
  return enumerateSites(schema, data, { scopes: true, schemaFrom });
}

/** The sites through which a resource drives another — its step and reference
 *  sites, with no schema-from expansion: the reach every throws question asks
 *  over, so none can reach a slot another cannot. */
export function drivenSites(schema: Record<string, any>, data: unknown): ReachSite[] {
  return enumerateSites(schema, data, { scopes: false });
}

interface SiteOptions {
  scopes: boolean;
  schemaFrom?: SchemaFromResolver;
}

function enumerateSites(
  schema: Record<string, any>,
  data: unknown,
  { scopes: keepScopes, schemaFrom }: SiteOptions,
): ReachSite[] {
  if (data === undefined || data === null) return [];
  const root = reachOfSchema(schema);
  const followsStops = keepScopes || schemaFrom !== undefined;
  if (!root.drives && !(followsStops && root.stops.size > 0)) return [];
  const sites = new Map<string, ReachSite & { from: Set<object> }>();
  const onData = new Set<unknown>([data]);
  const expanded = new Map<unknown, Set<SchemaReach>>();

  const siteAt = (path: string, value: unknown) => {
    let site = sites.get(path);
    if (!site) {
      site = { path, data: value, refs: [], steps: [], scopes: [], from: new Set() };
      sites.set(path, site);
    }
    return site;
  };

  const walk = (
    reach: SchemaReach,
    prefix: string,
    value: unknown,
    base: string,
    patternBase: string,
  ): void => {
    for (const [declaredPath, at] of reach.paths) {
      const rel = relativeFieldPath(declaredPath, prefix);
      if (rel === undefined) continue;
      for (const found of resolveSites(value, rel, prefix, reach)) {
        const path = joinPattern(base, found.path);
        if (at.steps.length > 0 || at.refs.length > 0) {
          const site = siteAt(path, found.value);
          for (const step of at.steps) {
            if (site.from.has(step)) continue;
            site.from.add(step);
            site.steps.push(step);
          }
          for (const entry of at.refs) {
            if (site.from.has(entry)) continue;
            site.from.add(entry);
            site.refs.push({
              slot: refSlotOfEntry(entry),
              fieldPath: joinPattern(patternBase, declaredPath),
              declaredIn: reach,
              declaredPath,
            });
          }
        }
        if (at.recurse.length === 0) continue;
        if (!found.value || typeof found.value !== "object" || onData.has(found.value)) continue;
        onData.add(found.value);
        for (const to of at.recurse) walk(reach, to, found.value, path, patternBase);
        onData.delete(found.value);
      }
    }
    if (!followsStops || reach.stops.size === 0) return;
    for (const [declaredPath, stop] of reach.stops) {
      const rel = relativeFieldPath(declaredPath, prefix);
      if (rel === undefined) continue;
      for (const found of resolveSites(value, rel, prefix, reach)) {
        const path = joinPattern(base, found.path);
        if (keepScopes && stop.scopes.length > 0) {
          const site = siteAt(path, found.value);
          for (const scope of stop.scopes) {
            if (site.from.has(scope)) continue;
            site.from.add(scope);
            site.scopes.push(scope);
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
          walk(anchored, "", found.value, path, joinPattern(patternBase, declaredPath));
          entered.delete(anchored);
        }
      }
    }
  };
  walk(root, "", data, "", "");

  return [...sites.values()].map(({ from, ...site }) => site);
}

interface Site {
  value: unknown;
  path: string;
}

/** The values at `rel` below `value`, where `rel` is relative to the pattern
 *  `prefix`. A `{}` segment skips the keys the reach records as declared for
 *  that pattern; each `[]` iterates one array level. */
function resolveSites(value: unknown, rel: string, prefix: string, reach: SchemaReach): Site[] {
  let sites: Site[] = [{ value, path: "" }];
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
          next.push({ value: entry, path: joinKey(site.path, key) });
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
          level = [{ value: entry, path: joinKey(site.path, key) }];
        } else {
          level = [site];
        }
        for (let d = 0; d < depth; d++) {
          const items: Site[] = [];
          for (const holder of level) {
            if (!Array.isArray(holder.value)) continue;
            holder.value.forEach((item, i) => {
              if (item != null) items.push({ value: item, path: `${holder.path}[${i}]` });
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

import { resolveLocalRef } from "./manifest-navigation.js";
import { type RefSlot, type RefUse, type RefUseCases, readRefSlot } from "./ref-slot.js";
import { readStepSlot, type StepSlot } from "./step-slot.js";

export { readRefSlot, isRefSlot, hasDeclaredUse } from "./ref-slot.js";
export type { RefSlot, RefUse, RefUseCases } from "./ref-slot.js";

/** An entry for a field that carries one or more x-telo-ref constraints. */
export interface RefFieldEntry {
  /** One or more canonical kind keys ("<module>.<Kind>"), or the deprecated
   *  identity form ("<namespace>/<module>#<Kind>") for a legacy published module.
   *  Multiple entries arise from a `kind:` list or from anyOf branches. */
  refs: string[];
  /** What the declaring resource does with the target — see {@link RefUse}.
   *  Empty for a slot still on the bare-string form. */
  uses: RefUse[];
  /** Set when the use is selected by a sibling config field. */
  useCases?: RefUseCases;
  /** JSON Pointer (relative to the object enclosing the slot) naming the field
   *  carrying this call's arguments. */
  inputs?: string;
  /** True when the field path traversed through at least one array (path contains "[]"). */
  isArray: boolean;
  /** The slot's non-reference branches, when the reference constraint is a
   *  branch of a union — see {@link RefSlot.valueBranches}. A value satisfying
   *  one of these is a value, not a malformed reference. */
  valueBranches?: Record<string, any>[];
  /** x-telo-context schema declared on this ref slot, if any. Describes the CEL invocation
   *  context available to resources placed in this slot. */
  context?: Record<string, any>;
  /** `x-telo-inline: true` — this slot accepts an inline `{kind, ...config}`
   *  definition, not only a `!ref`.
   *
   *  Only meaningful on the *system* kinds (`Telo.Application` and friends),
   *  which are otherwise excluded from inline-resource normalization wholesale.
   *  Ordinary resource kinds accept inline definitions at every ref slot and
   *  need no annotation. The flag exists so `logging.sinks` can opt in without
   *  also legalizing an inline definition in `targets`, where the Application
   *  schema rejects one deliberately — normalization runs upstream of AJV, so
   *  an unconditional opt-in would rewrite the value into a valid shape before
   *  the schema ever saw it. */
  inline?: boolean;
  /** See {@link RefSlot.throwsThrough}. */
  throwsThrough?: boolean;
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
  return slot;
}

/** Everything a driven-slot map records at one field path. */
export interface DrivenPath {
  /** Every reference slot declared here, by any branch. Kept apart rather than
   *  merged into one slot and read as a union: a branch that does not apply to a
   *  resource can only ADD what counts — more coverage demanded, never less — and
   *  one merged slot could not hold two case-map selectors or a branch that
   *  declares no use. */
  refs: RefFieldEntry[];
  /** Every step body declared here, by any branch. */
  steps: StepSlot[];
  /** Back-edges of a recursive schema: the schema here is also the one entered
   *  at each of these paths, so everything below them applies again below this
   *  one, as deep as a resource's data goes. Recorded BESIDE `refs`, never in
   *  place of them — a `!ref` here resolves as a reference, an inline object
   *  recurses. */
  recurse: string[];
}

/** See {@link buildDrivenSlotMap}. */
export interface DrivenSlots {
  paths: Map<string, DrivenPath>;
  /** Per `{}` field path, the keys JSON Schema does NOT apply that
   *  `additionalProperties` to: those the same schema declares under
   *  `properties`, plus the resource envelope at the root. Where several schemas
   *  meet at one `{}` path, only keys every one of them declares are skipped. */
  declaredKeys: Map<string, Set<string>>;
  /** True when some path holds a step or reference slot. A map of back-edges
   *  alone drives nothing, so a walk over it is skipped. */
  drives: boolean;
}

/** An entry for a field that declares an execution scope (x-telo-scope). */
export interface ScopeFieldEntry {
  /** JSON Pointer(s) (RFC 6901) declaring where x-telo-ref slots within this field can
   *  resolve to the scoped resources. */
  scope: string | string[];
}

/** An entry for a field whose schema is resolved dynamically from a referenced resource's
 *  definition schema (x-telo-schema-from). */
export interface SchemaFromFieldEntry {
  /** Full path expression as written in the schema, e.g.:
   *  - "backend/$defs/NodeOptions"   (relative: sibling x-telo-ref property)
   *  - "/backend/$defs/NodeOptions"  (absolute: root-level x-telo-ref property) */
  schemaFrom: string;
}

export type FieldMapEntry = RefFieldEntry | ScopeFieldEntry | SchemaFromFieldEntry;

/** Map from field path to its reference or scope metadata.
 *  Paths use dot notation; array traversal is denoted by `[]` (e.g. "steps[].invoke"). */
export type ReferenceFieldMap = Map<string, FieldMapEntry>;

export function isRefEntry(entry: FieldMapEntry): entry is RefFieldEntry {
  return "refs" in entry;
}

/** The half of a definition registry this question needs — structural, so the
 *  field map keeps depending on nothing. */
export interface ValueBranchValidator {
  schemaCompileError(schema: Record<string, any>): string | undefined;
  validateWithRefs(data: unknown, schema: Record<string, any>): string[];
}

/**
 * True when a value at a ref slot satisfies one of the slot's VALUE branches —
 * a storage class beside a `!ref`, so it is a value and not a malformed
 * reference.
 *
 * One implementation, because BOTH reference passes have to narrow the same way:
 * `validateReferenceForms` would otherwise call it a removed string reference,
 * and `validateReferences` a reference missing `kind` and `name`. Two copies of
 * the rule would eventually disagree about which of the two reported a value.
 *
 * A branch AJV cannot COMPILE is not a branch the value satisfies.
 * `validateWithRefs` returns no issues for one — it swallows the compile failure
 * by design, so one bad schema does not abort the pass — and reading that as
 * "no issues, therefore a value" would switch the reference-form rule off for
 * the slot silently. The uncompilable schema is reported on its own definition
 * by `schemaCompileError`.
 */
export function satisfiesValueBranch(
  value: unknown,
  branches: readonly Record<string, any>[] | undefined,
  registry: ValueBranchValidator,
): boolean {
  if (!branches?.length) return false;
  return branches.some(
    (branch) =>
      registry.schemaCompileError(branch) === undefined &&
      registry.validateWithRefs(value, branch).length === 0,
  );
}

export function isScopeEntry(entry: FieldMapEntry): entry is ScopeFieldEntry {
  return "scope" in entry;
}

export function isSchemaFromEntry(entry: FieldMapEntry): entry is SchemaFromFieldEntry {
  return "schemaFrom" in entry;
}

/** Keys that a named reference object may have. Values beyond these indicate an inline resource. */
export const REFERENCE_KEYS = new Set(["kind", "name", "metadata"]);

/** True when `val` is an inline resource definition rather than a named reference.
 *  Three shapes flow through here:
 *   - `{kind, name}` (optionally with runtime call args) → named reference, NOT inline.
 *   - `{kind, ...config}` with no name → inline definition with config; extract.
 *   - `{kind}` alone (bare kind, no name) → inline singleton — extract a fresh
 *     stateless resource. Lets simple stateless kinds be used inline without
 *     boilerplate (e.g. `encoder: {kind: Ndjson.Encoder}`, `invoke: {kind: Run.Throw}`).
 *
 *  A named reference (has string `name`) may carry extra keys (e.g. `inputs`)
 *  that are runtime call parameters — those are never inline resources. */
export function isInlineResource(val: Record<string, unknown>): boolean {
  if (typeof val.name === "string") return false;
  if (typeof val.kind !== "string") return false;
  return true;
}

/** A value found at a field-map path, paired with the concrete path that
 *  produced it. `path` has every `[]` substituted with `[N]` and every `{}`
 *  substituted with the actual map key, matching the format produced by
 *  `buildPositionIndex`. Used so diagnostics emitted against a specific
 *  array element / map entry can be resolved back to a YAML range. */
export interface ResolvedFieldEntry {
  value: unknown;
  path: string;
}

/** Resolves all `{value, path}` entries at a field map path in a resource
 *  config. The returned `path` is the concrete dotted path produced by the
 *  substitutions below, matching the format `buildPositionIndex` keys on.
 *  Path-segment markers accepted in the input `path`:
 *   - `[]`  iterate array values at this key, substituting `[N]` per item
 *           (e.g. `routes[]` → `routes[0]`, `routes[1]`, …).
 *   - `{}`  iterate map values (every value in an `additionalProperties`-typed
 *           object — used for fields like `content[mime]` whose schema declares
 *           a key-as-MIME map). Substituted with the literal map key joined by
 *           a dot, so the input `content.{}.encoder` yields concrete paths
 *           like `content.application/json.encoder`. */
export function resolveFieldEntries(obj: unknown, path: string): ResolvedFieldEntry[] {
  const parts = path.split(".");
  let current: ResolvedFieldEntry[] = [{ value: obj, path: "" }];
  for (const part of parts) {
    if (part === "{}") {
      const next: ResolvedFieldEntry[] = [];
      for (const entry of current) {
        if (!entry.value || typeof entry.value !== "object") continue;
        for (const [k, v] of Object.entries(entry.value as Record<string, unknown>)) {
          if (v != null) {
            next.push({ value: v, path: entry.path ? `${entry.path}.${k}` : k });
          }
        }
      }
      current = next;
      continue;
    }
    const isArray = part.endsWith("[]");
    const key = isArray ? part.slice(0, -2) : part;
    const next: ResolvedFieldEntry[] = [];
    for (const entry of current) {
      if (!entry.value || typeof entry.value !== "object") continue;
      const val = (entry.value as Record<string, unknown>)[key];
      if (val == null) continue;
      const basePath = entry.path ? `${entry.path}.${key}` : key;
      if (isArray && Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) {
          if (val[i] != null) next.push({ value: val[i], path: `${basePath}[${i}]` });
        }
      } else if (!isArray) {
        next.push({ value: val, path: basePath });
      }
    }
    current = next;
  }
  return current;
}

/** Backwards-compat wrapper that drops the concrete path. Prefer
 *  `resolveFieldEntries` for new code that wants positions. */
export function resolveFieldValues(obj: unknown, path: string): unknown[] {
  return resolveFieldEntries(obj, path).map((e) => e.value);
}

/**
 * Traverses a definition's JSON Schema once and returns a field map recording every
 * x-telo-ref slot and every x-telo-scope slot.
 *
 * - A node with `x-telo-ref` → RefFieldEntry with refs: [that value]
 * - A node with `anyOf` whose branches have `x-telo-ref` → RefFieldEntry with all branch refs
 * - A node with `x-telo-scope` → ScopeFieldEntry
 * - A node with `type: array` + `items` → recurse into items with path "fieldName[]"
 * - A node with `properties` → recurse into each property
 */
export function buildReferenceFieldMap(schema: Record<string, any>): ReferenceFieldMap {
  const map: ReferenceFieldMap = new Map();
  const sink = injectionSink(map);
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      traverseNode(propSchema as Record<string, any>, key, sink, schema);
    }
  }
  return map;
}

/** The accepted kinds a node declares, unioned across a `kind:` list and across
 *  `anyOf` branches. Thin wrapper over {@link readRefSlot} — kept because
 *  several passes want only the kind set. */
export function collectRefs(node: Record<string, any>): string[] {
  return readRefSlot(node)?.kinds ?? [];
}

/** Traverses an arbitrary JSON Schema starting at the given path prefix. Used to
 *  expand x-telo-schema-from sub-schemas into nested ref/scope entries so Phase 2
 *  inline normalization and Phase 5 injection see slots that the local field map
 *  hid behind the schema-from indirection. */
export function buildFieldMapAtPath(
  schema: Record<string, any>,
  pathPrefix: string,
): ReferenceFieldMap {
  const map: ReferenceFieldMap = new Map();
  traverseNode(schema, pathPrefix, injectionSink(map), schema);
  return map;
}

const drivenSlotMaps = new WeakMap<object, DrivenSlots>();

/** The resource envelope: present on every resource document, and never
 *  configuration a kind's root `additionalProperties` describes. */
const RESOURCE_ENVELOPE_KEYS = ["kind", "metadata"];

/**
 * Every slot through which a resource of this schema DRIVES another — the
 * reference field map's own traversal, plus what a dispatch analysis needs and
 * the injection surface must not have:
 *
 * - local `$ref` is followed, resolved against the root. The injection map
 *   stops there so a step's `invoke` never becomes an injection site; this map
 *   stops AT a step body instead, which removes that reason. A reference back
 *   to a node already on the descent is recorded as a back-edge rather than
 *   unrolled, so a recursive shape stays finite here and is followed as deep as
 *   the data goes by `forEachDrivenSlot`;
 * - a step body is recorded and not descended — the step traversal owns
 *   everything below it;
 * - the root's own variant branches and `additionalProperties` are walked, not
 *   only its `properties`;
 * - a path keeps EVERY slot any branch declares there, where the injection map
 *   keeps the last one written (see {@link DrivenPath.refs});
 * - each `{}` path records the keys its `additionalProperties` does not cover.
 *
 * Shared by every throws question (a kind's `inherit` union, a scope list's
 * denominator, catch-scope enclosure, and whether `inherit` is legal at all),
 * so none can reach a slot another cannot. Memoized per schema object.
 */
export function buildDrivenSlotMap(schema: Record<string, any>): DrivenSlots {
  const cached = drivenSlotMaps.get(schema);
  if (cached) return cached;
  const slots: DrivenSlots = { paths: new Map(), declaredKeys: new Map(), drives: false };
  traverseNode(schema, "", drivenSink(slots), schema);
  drivenSlotMaps.set(schema, slots);
  return slots;
}

const joinPath = (path: string, key: string): string => (path ? `${path}.${key}` : key);

/** Where a traversal records what it finds. */
interface FieldMapSink {
  readonly driven: boolean;
  ref(path: string, entry: RefFieldEntry, node: Record<string, any>): void;
  stop(path: string, entry: ScopeFieldEntry | SchemaFromFieldEntry): void;
  step(path: string, step: StepSlot, node: Record<string, any>): void;
  recurse(path: string, to: string): void;
  mapValue(mapPath: string, declared: string[]): void;
}

/** The injection map: one entry per path, the last one written. Step bodies,
 *  back-edges and map-value keys are the driven map's alone. */
function injectionSink(map: ReferenceFieldMap): FieldMapSink {
  return {
    driven: false,
    ref: (path, entry) => {
      map.set(path, entry);
    },
    stop: (path, entry) => {
      map.set(path, entry);
    },
    step: () => {},
    recurse: () => {},
    mapValue: () => {},
  };
}

function drivenSink(slots: DrivenSlots): FieldMapSink {
  const recorded = new Map<string, Set<object>>();
  const at = (path: string): DrivenPath => {
    let entry = slots.paths.get(path);
    if (!entry) {
      entry = { refs: [], steps: [], recurse: [] };
      slots.paths.set(path, entry);
    }
    return entry;
  };
  // One schema node reached twice at one path (two branches `$ref`-ing one
  // definition) is one slot.
  const firstTime = (path: string, node: object): boolean => {
    let nodes = recorded.get(path);
    if (!nodes) recorded.set(path, (nodes = new Set()));
    if (nodes.has(node)) return false;
    nodes.add(node);
    return true;
  };
  return {
    driven: true,
    ref: (path, entry, node) => {
      if (!firstTime(path, node)) return;
      at(path).refs.push(entry);
      slots.drives = true;
    },
    stop: () => {},
    step: (path, step, node) => {
      if (!firstTime(path, node)) return;
      at(path).steps.push(step);
      slots.drives = true;
    },
    recurse: (path, to) => {
      const entry = at(path);
      if (!entry.recurse.includes(to)) entry.recurse.push(to);
    },
    mapValue: (mapPath, declared) => {
      const previous = slots.declaredKeys.get(mapPath);
      slots.declaredKeys.set(
        mapPath,
        new Set(previous ? declared.filter((key) => previous.has(key)) : declared),
      );
    },
  };
}

/** Follow a local `$ref` in driven mode. `onStack` maps each node on the
 *  current descent to the path it was entered at: re-entering one records a
 *  back-edge to that path, and a cycle that made no structural progress (same
 *  path) records nothing, since its body is already recorded there. */
function followLocalRef(
  node: Record<string, any>,
  path: string,
  sink: FieldMapSink,
  root: Record<string, any> | undefined,
  onStack: Map<Record<string, any>, string>,
): void {
  if (!root) return;
  const target = resolveLocalRef(node, root);
  if (!target || target === node) return;
  const entered = onStack.get(target);
  if (entered !== undefined) {
    if (entered !== path) sink.recurse(path, entered);
    return;
  }
  onStack.set(target, path);
  try {
    traverseNode(target, path, sink, root, onStack);
  } finally {
    onStack.delete(target);
  }
}

/** `owner.additionalProperties`, the schema of every value in an open-keyed
 *  object. JSON Schema applies it only to keys `owner` does not declare, which
 *  the driven map records so a walk skips them. */
function traverseMapValue(
  owner: Record<string, any>,
  path: string,
  sink: FieldMapSink,
  root: Record<string, any> | undefined,
  onStack: Map<Record<string, any>, string>,
): void {
  const valueSchema = owner.additionalProperties;
  if (!valueSchema || typeof valueSchema !== "object" || Array.isArray(valueSchema)) return;
  const mapPath = joinPath(path, "{}");
  const declared =
    owner.properties && typeof owner.properties === "object" ? Object.keys(owner.properties) : [];
  sink.mapValue(mapPath, path === "" ? [...declared, ...RESOURCE_ENVELOPE_KEYS] : declared);
  traverseNode(valueSchema as Record<string, any>, mapPath, sink, root, onStack);
}

function traverseNode(
  node: Record<string, any>,
  path: string,
  sink: FieldMapSink,
  root?: Record<string, any>,
  onStack: Map<Record<string, any>, string> = new Map(),
): void {
  const driven = sink.driven;
  // Local `$ref` is intentionally NOT followed here. This map is the kernel's
  // Phase-5 injection surface: descending into shared `$defs` (notably
  // `Run.Sequence`'s `step` definition) would make every step's `invoke` an
  // injection site, and step slots resolve at dispatch — injecting there is
  // unwanted regardless of tracing (the original dispatcher-bypass blocker
  // has since shipped via the `REF_IDENTITY` stamp). Static analysis is NOT
  // limited by this stop: the call graph (`call-graph.ts`) reads step slots
  // from the item schema itself and scans the value tree, and the driven-slot
  // mode (`buildDrivenSlotMap`) follows the reference.
  if (typeof node?.$ref === "string" && !driven) return;
  // Scope slot — record and stop; do not recurse into scope contents
  if ("x-telo-scope" in node) {
    sink.stop(path, { scope: node["x-telo-scope"] });
    return;
  }

  // Schema-from slot — record and stop; no further traversal needed
  if ("x-telo-schema-from" in node) {
    sink.stop(path, { schemaFrom: node["x-telo-schema-from"] });
    return;
  }

  if (driven) {
    const step = readStepSlot(node);
    if (step) {
      sink.step(path, step, node);
      return;
    }
  }

  // Reference slot (direct, via a `kind:` list, or via anyOf)
  const slot = readRefSlot(node);
  if (slot && slot.kinds.length > 0) {
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
    sink.ref(path, entry, node);
    // A node can mix item-level ref branches (a bare string / `{kind, name}`)
    // with object branches that carry their OWN nested refs — e.g. Application
    // `targets`: a bare ref vs inline `{ invoke }` vs gated `{ ref }`. Descend
    // into the variant objects so those nested slots register too (and their
    // `!ref` sentinels resolve). Pure x-telo-ref branches have no properties
    // and contribute nothing here.
    for (const variantKey of ["oneOf", "anyOf", "allOf"] as const) {
      const variants = node[variantKey];
      if (!Array.isArray(variants)) continue;
      for (const variant of variants) {
        if (!variant || typeof variant !== "object") continue;
        traverseVariant(variant as Record<string, any>, path, sink, root, onStack);
      }
    }
    return;
  }
  // Reached only in driven mode — the injection map stopped at the top.
  if (typeof node?.$ref === "string") {
    followLocalRef(node, path, sink, root, onStack);
    return;
  }

  // Array — recurse into items
  if (node.type === "array" && node.items) {
    traverseNode(node.items as Record<string, any>, path + "[]", sink, root, onStack);
  }

  // Object — recurse into properties
  if (node.properties) {
    for (const [key, propSchema] of Object.entries(node.properties)) {
      traverseNode(propSchema as Record<string, any>, joinPath(path, key), sink, root, onStack);
    }
  }

  // Variant branches — descend into every alternative's properties / items.
  // Schemas that discriminate on shape (Run.Sequence's step kinds:
  // `oneOf: [{properties: {invoke}}, {properties: {try}}, ...]`) hide ref
  // slots inside the branch. Walking each branch surfaces those slots into
  // the field map so downstream passes (ref validation, sentinel
  // resolution, dependency graph) cover them without a runtime fallback.
  // The same field path may be added by multiple branches. The injection map
  // keeps the later assignment, which is fine for injection — branches with
  // the same field path share the same ref/context configuration. The driven
  // map keeps every one, because which branch applies decides what a
  // dispatch can throw.
  for (const variantKey of ["oneOf", "anyOf", "allOf"] as const) {
    const variants = node[variantKey];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      if (!variant || typeof variant !== "object") continue;
      traverseVariant(variant as Record<string, any>, path, sink, root, onStack);
    }
  }

  // Map — `additionalProperties: { ... }` describes every value in an
  // open-keyed object. Encoder refs nested inside `content[mime]` map
  // entries reach Phase 5 through this branch.
  traverseMapValue(node, path, sink, root, onStack);
}

/** Walk a single variant of a `oneOf` / `anyOf` / `allOf` branch. Only
 *  the properties / items / map slots are followed — collectRefs at the
 *  variant root is handled by the parent's `collectRefs(node)` already
 *  (anyOf of x-telo-ref branches is the canonical multi-ref shape). In
 *  driven mode a `$ref` branch is followed as a node in its own right, since
 *  `readRefSlot` does not look through one. */
function traverseVariant(
  variant: Record<string, any>,
  path: string,
  sink: FieldMapSink,
  root?: Record<string, any>,
  onStack: Map<Record<string, any>, string> = new Map(),
): void {
  if (sink.driven && typeof variant.$ref === "string") {
    followLocalRef(variant, path, sink, root, onStack);
    return;
  }
  if (variant.properties) {
    for (const [key, propSchema] of Object.entries(variant.properties)) {
      traverseNode(propSchema as Record<string, any>, joinPath(path, key), sink, root, onStack);
    }
  }
  if (variant.type === "array" && variant.items) {
    traverseNode(variant.items as Record<string, any>, path + "[]", sink, root, onStack);
  }
  traverseMapValue(variant, path, sink, root, onStack);
}

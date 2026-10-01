/**
 * The schema-projection annotations' single reader — the `ref-slot.ts` /
 * `zone-slot.ts` precedent.
 *
 * A kind whose configuration is a COLLECTION OF TYPED ENTRIES can say what that
 * collection means as a JSON Schema object, so a consumer can type the values
 * it will read without the analyzer learning anything about the domain. A SQL
 * table's columns are the first consumer; nothing in either annotation says
 * SQL, column or table.
 *
 * Two halves, because the two facts have different owners:
 *
 * - `x-telo-schema-map`, on the field a projection keys on, gives the schema
 *   node each of its values means (`citext → {type: string}`). It sits with the
 *   field because that is where the value vocabulary is declared.
 * - `x-telo-schema-projection`, on the KIND DOCUMENT (a sibling of `schema:`,
 *   not a keyword inside it), names the entry collection, the keying field, and
 *   the fields that MODIFY the mapped node. It sits on the document because it
 *   describes the kind's whole declaration rather than one field of it — but
 *   `schema:` is where every other `x-telo-*` keyword lives, so the reader
 *   accepts it in both positions and `validate-schema-projection.ts` reports the
 *   inner one. Silently ignoring a misplaced annotation is the exact failure the
 *   strict half exists to prevent: the projection stops typing its consumers and
 *   the diagnostic lands on the CONSUMER, blaming the wrong author.
 *
 * It is a declared LOOKUP, never a computed expression. The analyzer
 * type-checks CEL and substitutes placeholders; it never evaluates, and a
 * `base:`-style mapping is evaluated by the kernel at `create()` — too late for
 * `telo check` to type the rows a consumer reads, which is the projection's
 * whole purpose.
 *
 * Distinct from `x-telo-schema-from`, which derives a field's schema from a
 * referenced KIND's definition schema. A projection is DECLARATION-derived: the
 * row shape lives in one instance's own `columns:`, which no definition-level
 * derivation can reach.
 */

import { isCompiledValue, type ResourceManifest } from "@telorun/sdk";
import { isRefSentinel, isTaggedSentinel } from "@telorun/templating";
import type { LibraryDeclarations } from "./library-declarations.js";
import { createAjv } from "./schema-compat.js";
import { isInjectedDeclaration, readSuppliedResources } from "./resource-input.js";

/** How a kind's entry collection projects to an object schema. */
export interface SchemaProjection {
  /** JSON Pointer, from the resource root, to the entries. */
  readonly entries: string;
  /** The entry field whose value keys the `x-telo-schema-map` lookup. */
  readonly key: string;
  /** The entry field naming an entry's identity, when entries are an ARRAY.
   *  Absent for a keyed map, where the map key is the identity. */
  readonly nameField?: string;
  /** Entry field that widens the mapped node to admit null. */
  readonly nullable?: string;
  /** Entry field that wraps the mapped node in an array. */
  readonly array?: string;
  /**
   * Entry field holding a SUB-COLLECTION of entries of the same shape. An entry
   * carrying it projects to the closed object that sub-collection projects to —
   * recursively, with the same key, map and modifiers — instead of through the
   * map; `array` and `nullable` then apply as for any entry.
   */
  readonly nested?: string;
  /**
   * How an entry whose keyed field holds a REFERENCE projects.
   *
   * The map is keyed on the field's VALUE, and a reference is not a key, so a
   * `type:` holding one falls through to this path. It is declared as data by the
   * backend, which is what keeps the analyzer from learning that an enum exists:
   * `from` names the field of the target declaration to read, `keyword` the
   * schema keyword its values become, and `base` / `baseFrom` where the node's
   * own type comes from — a literal for an engine whose named type IS its own
   * base, a field of the target for one that declares a storage class.
   *
   * A backend that declares none projects exactly as it did before.
   */
  readonly reference?: ProjectionReference;
}

/** The reference path of a projection — see {@link SchemaProjection.reference}. */
export interface ProjectionReference {
  /** Field of the TARGET declaration whose value the keyword takes. */
  readonly from: string;
  /** The JSON Schema keyword those values become (`enum`). */
  readonly keyword: string;
  /** The node the keyword is added to, written literally. */
  readonly base?: Record<string, unknown>;
  /** Field of the target declaration naming a value in the kind's own
   *  `x-telo-schema-map`, whose mapped node is the base. */
  readonly baseFrom?: string;
}

export type SchemaMap = Readonly<Record<string, Record<string, unknown>>>;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The projection a kind declares, or undefined. Invalid shapes read as absent;
 *  `validate-schema-projection.ts` is the half that reports them. */
export function readSchemaProjection(definition: unknown): SchemaProjection | undefined {
  if (!isObject(definition)) return undefined;
  const raw = rawSchemaProjection(definition);
  if (!isObject(raw)) return undefined;
  const entries = raw.entries;
  const key = raw.key;
  if (typeof entries !== "string" || typeof key !== "string") return undefined;
  return {
    entries,
    key,
    nameField: typeof raw.name === "string" ? raw.name : undefined,
    nullable: typeof raw.nullable === "string" ? raw.nullable : undefined,
    array: typeof raw.array === "string" ? raw.array : undefined,
    nested: typeof raw.nested === "string" ? raw.nested : undefined,
    reference: readProjectionReference(raw.reference),
  };
}

function readProjectionReference(raw: unknown): ProjectionReference | undefined {
  if (!isObject(raw)) return undefined;
  const { from, keyword, base, baseFrom } = raw;
  if (typeof from !== "string" || typeof keyword !== "string") return undefined;
  return {
    from,
    keyword,
    base: isObject(base) ? (base as Record<string, unknown>) : undefined,
    baseFrom: typeof baseFrom === "string" ? baseFrom : undefined,
  };
}

/** The annotation as written, from either position — the document (canonical)
 *  or `schema:` (accepted, and reported by the strict half). The document wins:
 *  a kind spelling it in both places is describing its own document. */
export function rawSchemaProjection(definition: unknown): unknown {
  if (!isObject(definition)) return undefined;
  const own = definition["x-telo-schema-projection"];
  if (own !== undefined) return own;
  const schema = definition.schema;
  return isObject(schema) ? schema["x-telo-schema-projection"] : undefined;
}

/** True when the annotation was found inside `schema:` rather than on the
 *  document — the misplacement the strict half reports. */
export function schemaProjectionIsMisplaced(definition: unknown): boolean {
  if (!isObject(definition)) return false;
  if (definition["x-telo-schema-projection"] !== undefined) return false;
  const schema = definition.schema;
  return isObject(schema) && schema["x-telo-schema-projection"] !== undefined;
}

/**
 * The schema node that CARRIES the value vocabulary — the node itself, or the
 * branch of a union that declares the map.
 *
 * A slot unioning a closed value vocabulary with a reference keeps its map on the
 * value branch, exactly as the ref-slot reader peels the same union for its
 * constraint. Exported because the strict half checks the map against the same
 * branch's `enum`, and two implementations of "which branch is the value one"
 * would eventually disagree — silently, since the failure of missing one is a
 * completeness check that quietly stops running.
 */
export function schemaMapBranch(node: unknown): Record<string, unknown> | undefined {
  if (!isObject(node)) return undefined;
  if (node["x-telo-schema-map"] !== undefined) return node;
  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (isObject(branch) && branch["x-telo-schema-map"] !== undefined) return branch;
    }
  }
  return undefined;
}

export function readSchemaMap(node: unknown): SchemaMap | undefined {
  return ownSchemaMap(schemaMapBranch(node));
}

function ownSchemaMap(node: unknown): SchemaMap | undefined {
  if (!isObject(node)) return undefined;
  const raw = node["x-telo-schema-map"];
  if (!isObject(raw)) return undefined;
  const entries = Object.entries(raw).filter(([, value]) => isObject(value));
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries) as SchemaMap;
}

const PROJECTION_FROM = "x-telo-schema-projection-from";

/**
 * What a slot (or, on a kind document, every declaration of the kind) is typed
 * from: the declaration `from` points at, optionally narrowed to ONE entry
 * (`pick`, a pointer to a field holding the entry's name) or without some
 * (`omit`, pointers to fields each holding one). Every pointer is relative to
 * the declaration carrying the annotated slot, and may cross references.
 */
export interface ProjectionDerivation {
  readonly from: string;
  readonly pick?: string;
  readonly omit?: readonly string[];
}

/** The keys the object form may carry. Closed, for the reason
 *  {@link SCHEMA_PROJECTION_KEYS} is. */
export const PROJECTION_DERIVATION_KEYS: readonly string[] = ["from", "pick", "omit"];

/** A derivation as read, or why the annotation that is present cannot be read. */
export type DerivationRead = { readonly derivation: ProjectionDerivation } | { readonly invalid: string };

/** Read the annotation's string or object form. Undefined when absent; the
 *  strict half reports an `invalid` one, and the kernel refuses to bind it. */
export function readProjectionDerivation(raw: unknown): DerivationRead | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") return { derivation: { from: raw } };
  if (!isObject(raw)) {
    return { invalid: `'${PROJECTION_FROM}' is a JSON Pointer, or an object '{ from, pick?, omit? }'.` };
  }
  const unknown = Object.keys(raw).filter((key) => !PROJECTION_DERIVATION_KEYS.includes(key));
  if (unknown.length > 0) {
    return {
      invalid:
        `'${PROJECTION_FROM}' has no ${unknown.map((k) => `'${k}'`).join(", ")}. It declares ` +
        `${PROJECTION_DERIVATION_KEYS.map((k) => `'${k}'`).join(", ")}.`,
    };
  }
  const { from, pick, omit } = raw;
  if (typeof from !== "string") {
    return { invalid: `'${PROJECTION_FROM}' needs 'from', a JSON Pointer to the declaration to project.` };
  }
  if (pick !== undefined && typeof pick !== "string") {
    return { invalid: `'pick' is a JSON Pointer to a field holding the one entry's name.` };
  }
  if (omit !== undefined && !(Array.isArray(omit) && omit.every((p) => typeof p === "string"))) {
    return { invalid: `'omit' is a list of JSON Pointers, each to a field holding an entry's name.` };
  }
  return {
    derivation: {
      from,
      ...(pick !== undefined ? { pick } : {}),
      ...(omit !== undefined ? { omit: omit as string[] } : {}),
    },
  };
}

/** The consumer-side annotation on a schema node, leniently: a malformed one
 *  reads as absent. */
export function readProjectionFrom(node: unknown): ProjectionDerivation | undefined {
  if (!isObject(node)) return undefined;
  const read = readProjectionDerivation(node[PROJECTION_FROM]);
  return read && "derivation" in read ? read.derivation : undefined;
}

/**
 * The annotation on a KIND DOCUMENT: every declaration of the kind projects as
 * this derivation. Declaring it beside `x-telo-schema-projection` gives the kind
 * two meanings, and `pick` would make a declaration project to a single entry
 * rather than to an object — both are `invalid`.
 */
export function readKindDerivation(definition: unknown): DerivationRead | undefined {
  if (!isObject(definition)) return undefined;
  const read = readProjectionDerivation(definition[PROJECTION_FROM]);
  if (!read || "invalid" in read) return read;
  if (rawSchemaProjection(definition) !== undefined) {
    return {
      invalid:
        `a kind declares its projection once: '${PROJECTION_FROM}' derives it from another ` +
        `declaration and 'x-telo-schema-projection' reads it from this one's entries — keep one.`,
    };
  }
  if (read.derivation.pick !== undefined) {
    return {
      invalid:
        `'pick' types a slot as ONE entry; on a kind document the declaration must project to an ` +
        `object, so only 'from' and 'omit' apply here.`,
    };
  }
  return read;
}

function decodePointer(pointer: string): string[] {
  return pointer
    .split("/")
    .filter((segment) => segment !== "")
    .map(decodeSegment);
}

function navigate(root: unknown, pointer: string): unknown {
  let current: unknown = root;
  for (const segment of decodePointer(pointer)) {
    if (!isObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** The keys `x-telo-schema-projection` may carry. The annotation is closed: a
 *  key nothing reads is a modifier the author believes applies and none does. */
export const SCHEMA_PROJECTION_KEYS: readonly string[] = [
  "entries",
  "key",
  "name",
  "nullable",
  "array",
  "nested",
  "reference",
];

function decodeSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Follow a document-local `$ref` chain (`#/…`) against the kind schema. A
 *  node that is not a local reference is returned as it is. */
function resolveLocal(node: unknown, root: unknown): unknown {
  let current = node;
  const seen = new Set<unknown>();
  while (isObject(current) && typeof current.$ref === "string" && current.$ref.startsWith("#")) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    let target: unknown = root;
    for (const segment of current.$ref.slice(1).split("/")) {
      if (segment === "") continue;
      if (!isObject(target)) return undefined;
      target = target[decodeSegment(segment)];
    }
    current = target;
  }
  return current;
}

/** The schema of the collection a projection names, reached from the kind
 *  schema through `properties`, following local references. */
export function projectionCollectionSchema(
  kindSchema: unknown,
  entries: string,
): Record<string, unknown> | undefined {
  let node = resolveLocal(kindSchema, kindSchema);
  for (const segment of entries.split("/")) {
    if (segment === "") continue;
    if (!isObject(node) || !isObject(node.properties)) return undefined;
    node = resolveLocal(node.properties[decodeSegment(segment)], kindSchema);
  }
  return isObject(node) ? node : undefined;
}

/** The ENTRY schema of a collection node — a keyed map's `additionalProperties`
 *  or an array's `items` — following local references. */
export function collectionEntrySchema(
  collection: unknown,
  kindSchema: unknown,
): Record<string, unknown> | undefined {
  if (!isObject(collection)) return undefined;
  const raw = isObject(collection.additionalProperties)
    ? collection.additionalProperties
    : isObject(collection.items)
      ? collection.items
      : undefined;
  const entry = resolveLocal(raw, kindSchema);
  return isObject(entry) ? entry : undefined;
}

/** The schema of one field of a projection's entries, following local references. */
export function projectionEntryField(
  kindSchema: unknown,
  projection: SchemaProjection,
  field: string,
): Record<string, unknown> | undefined {
  const entry = collectionEntrySchema(
    projectionCollectionSchema(kindSchema, projection.entries),
    kindSchema,
  );
  if (!entry || !isObject(entry.properties)) return undefined;
  const node = resolveLocal(entry.properties[field], kindSchema);
  return isObject(node) ? node : undefined;
}

/**
 * Find the `x-telo-schema-map` a projection keys on. The map sits on the entry
 * field's schema, which is reached through the collection's own schema — a
 * keyed map's `additionalProperties`, or an array's `items`.
 */
export function projectionKeyMap(
  kindSchema: unknown,
  projection: SchemaProjection,
): SchemaMap | undefined {
  return readSchemaMap(projectionEntryField(kindSchema, projection, projection.key));
}

/** Where a failure about one entry is anchored: the entry itself when the
 *  projected declaration is the one carrying the diagnostic (the EMPTY
 *  pointer), otherwise the consumer's slot — entry paths of a DIFFERENT
 *  manifest mean nothing in the consumer's file. */
function failureAnchor(entryPointer: string, projection: SchemaProjection, options?: ProjectOptions): string {
  return options?.pointer === "" ? entryPointer : (options?.pointer ?? projection.entries);
}

/**
 * The node an entry whose keyed field holds a REFERENCE projects to.
 *
 * This is the one place a projection crosses to another declaration, and it is
 * a deliberate exception to the projection's lossiness: length, precision and
 * collation stop at the boundary because the database enforces them, while a
 * domain crosses because it IS the type at the granularity a consumer acts on —
 * the enum in a CRUD model's OpenAPI operation, a completion list in the editor,
 * a filter a repository can reject before the query.
 *
 * **A reference that cannot be read projects OPEN, never to nothing**, and that
 * is the opposite of the rule an unmapped VALUE follows. The two failures are
 * not the same failure: an unmapped value is a gap in the kind's own vocabulary,
 * so there is no entry to speak of, while an unreadable reference names an entry
 * the declaration plainly HAS and only leaves its type unknown. Dropping it made
 * the projection deny the entry exists — a table whose enum reference had a typo
 * reported `'status' is not allowed` against a column declared three lines up,
 * blaming the seed row for the reference's mistake. Open is the honest
 * under-approximation, and the reason is reported alongside.
 */
function referencedNode(
  value: unknown,
  entryName: string,
  entryPointer: string,
  projection: SchemaProjection,
  map: SchemaMap,
  holder: Record<string, any> | undefined,
  options?: ProjectOptions,
): Record<string, unknown> | undefined {
  const reference = projection.reference;
  if (!reference || !isObject(value)) return undefined;
  // Through the single reader, so the name in the diagnostic is the one the
  // author wrote whichever shape the slot holds — reading `value.name` here
  // reported `<unnamed>` for an unresolved `!ref`, which is precisely the case
  // that produces the diagnostic.
  const name = readProjectionRef(value)?.name ?? "<unnamed>";
  const report = (): Record<string, unknown> => {
    options?.failures?.push({
      reason: "entry-reference",
      pointer: failureAnchor(entryPointer, projection, options),
      entry: entryName,
      name,
    });
    return {};
  };
  const found = options?.scope?.resolveManifest(value, holder);
  if (!found || !("manifest" in found)) return report();

  const values = (found.manifest as Record<string, unknown>)[reference.from];
  if (!Array.isArray(values) || values.length === 0) return report();

  let base: Record<string, unknown> | undefined = reference.base;
  if (reference.baseFrom !== undefined) {
    const declared = (found.manifest as Record<string, unknown>)[reference.baseFrom];
    base = typeof declared === "string" ? map[declared] : undefined;
  }
  if (!base) return report();
  return { ...base, [reference.keyword]: values };
}

/** What projecting a declaration may be given beyond the projection and map. */
export interface ProjectOptions {
  /** What a REFERENCE at the keyed field is resolved through. A caller with no
   *  scope cannot resolve one, so such an entry projects OPEN — present,
   *  untyped — rather than vanishing from the row. */
  readonly scope?: ProjectionScope;
  /** The consumer slot the projection is written at; the EMPTY pointer is the
   *  declaration itself. Decides where an entry's failure is anchored. */
  readonly pointer?: string;
  /** Where a failure to read an entry is reported. */
  readonly failures?: ProjectionFailure[];
  /** The kind's `schema:`, read for the `default:` of a modifier an entry
   *  omits. Without it an omitted modifier reads as absent. */
  readonly kindSchema?: unknown;
}

/** One projection run: the fixed inputs, and the entries on the current path. */
interface ProjectionRun {
  readonly projection: SchemaProjection;
  readonly map: SchemaMap;
  readonly options?: ProjectOptions;
  /** Where each modifier's `default:` is declared, from the entry schema. */
  readonly defaultSites: Readonly<Record<string, readonly ModifierDefaultSite[]>>;
  readonly ancestors: Set<object>;
  /** The declaration being projected — where an entry's reference resolves. */
  readonly declaration?: Record<string, any>;
}

/**
 * A place the entry schema declares a modifier's `default:` — on the field
 * itself, or in the `then` / `else` of a conditional over the entry (at the
 * entry schema's root or one of its `allOf` members), so the default can depend
 * on the entry's other fields. `path` is where the site is written, from the
 * entry schema.
 */
export type ModifierDefaultSite =
  | { readonly kind: "field"; readonly path: string; readonly value: unknown }
  | {
      readonly kind: "conditional";
      readonly path: string;
      readonly condition: unknown;
      readonly then?: { readonly value: unknown };
      readonly else?: { readonly value: unknown };
    };

function branchDefault(branch: unknown, field: string, root: unknown): { value: unknown } | undefined {
  const node = resolveLocal(branch, root);
  if (!isObject(node) || !isObject(node.properties)) return undefined;
  const property = resolveLocal(node.properties[field], root);
  return isObject(property) && "default" in property ? { value: property.default } : undefined;
}

/** Every site declaring `field`'s `default:` for an entry of `entrySchema`.
 *  More than one is a contradiction the strict half reports. */
export function modifierDefaultSites(
  entrySchema: Record<string, unknown>,
  field: string,
  root: unknown,
): ModifierDefaultSite[] {
  const sites: ModifierDefaultSite[] = [];
  const own = isObject(entrySchema.properties) ? resolveLocal(entrySchema.properties[field], root) : undefined;
  if (isObject(own) && "default" in own) {
    sites.push({ kind: "field", path: `properties.${field}.default`, value: own.default });
  }
  const visit = (raw: unknown, path: string, seen: Set<unknown>): void => {
    const node = resolveLocal(raw, root);
    if (!isObject(node) || seen.has(node)) return;
    seen.add(node);
    if (node.if !== undefined) {
      const thenDefault = branchDefault(node.then, field, root);
      const elseDefault = branchDefault(node.else, field, root);
      if (thenDefault || elseDefault) {
        sites.push({
          kind: "conditional",
          path: path === "" ? "if" : `${path}.if`,
          condition: node.if,
          ...(thenDefault ? { then: thenDefault } : {}),
          ...(elseDefault ? { else: elseDefault } : {}),
        });
      }
    }
    if (Array.isArray(node.allOf)) {
      node.allOf.forEach((member, index) =>
        visit(member, path === "" ? `allOf[${index}]` : `${path}.allOf[${index}]`, seen),
      );
    }
  };
  visit(entrySchema, "", new Set());
  return sites;
}

type ConditionCheck = ((entry: unknown) => boolean) | { readonly error: string };
const compiledConditions = new WeakMap<object, ConditionCheck>();
let conditionAjv: ReturnType<typeof createAjv> | undefined;

/**
 * A conditional's `if`, compiled as JSON Schema — or why it cannot be. Evaluated
 * against the entry AS WRITTEN: a computed value is not a literal, so it matches
 * no `const` and the entry lands in the branch that does not rely on it.
 */
export function compileDefaultCondition(condition: unknown): ConditionCheck {
  if (typeof condition === "boolean") return () => condition;
  if (!isObject(condition)) return { error: "an 'if' is a JSON Schema: an object or a boolean" };
  const cached = compiledConditions.get(condition);
  if (cached) return cached;
  let check: ConditionCheck;
  try {
    const validate = (conditionAjv ??= createAjv()).compile(condition);
    check = (entry) => validate(entry) === true;
  } catch (error) {
    check = { error: error instanceof Error ? error.message : String(error) };
  }
  compiledConditions.set(condition, check);
  return check;
}

/** The default declared for `field` that applies to this entry, or undefined —
 *  none declared, or declared ambiguously (reported by the strict half). */
function applicableDefault(sites: readonly ModifierDefaultSite[] | undefined, entry: unknown): unknown {
  if (!sites || sites.length !== 1) return undefined;
  const [site] = sites;
  if (site.kind === "field") return site.value;
  const check = compileDefaultCondition(site.condition);
  if (typeof check !== "function") return undefined;
  return (check(entry) ? site.then : site.else)?.value;
}

function modifierDefaultSitesOf(
  projection: SchemaProjection,
  kindSchema: unknown,
): Record<string, readonly ModifierDefaultSite[]> {
  const sites: Record<string, readonly ModifierDefaultSite[]> = {};
  if (kindSchema === undefined) return sites;
  const entry = collectionEntrySchema(projectionCollectionSchema(kindSchema, projection.entries), kindSchema);
  if (!entry) return sites;
  for (const field of [projection.array, projection.nullable]) {
    if (field !== undefined) sites[field] = modifierDefaultSites(entry, field, kindSchema);
  }
  return sites;
}

function projectCollection(
  collection: unknown,
  collectionPointer: string,
  run: ProjectionRun,
): Record<string, unknown> | undefined {
  const pairs: [string, Record<string, unknown>][] = [];
  const consider = (name: unknown, segment: string, entry: unknown): void => {
    if (!isObject(entry) || typeof name !== "string") return;
    const node = projectEntry(entry, name, `${collectionPointer}/${segment}`, run);
    if (node) pairs.push([name, node]);
  };
  const { nameField } = run.projection;
  if (Array.isArray(collection)) {
    collection.forEach((entry, index) =>
      consider(isObject(entry) && nameField ? entry[nameField] : undefined, String(index), entry),
    );
  } else if (isObject(collection)) {
    for (const [name, entry] of Object.entries(collection)) consider(name, name, entry);
  } else {
    return undefined;
  }
  return {
    type: "object",
    properties: Object.fromEntries(pairs),
    additionalProperties: false,
  };
}

function projectEntry(
  entry: Record<string, unknown>,
  name: string,
  entryPointer: string,
  run: ProjectionRun,
): Record<string, unknown> | undefined {
  const { projection, map, options } = run;
  const sub = projection.nested === undefined ? undefined : entry[projection.nested];
  let mapped: Record<string, unknown> | undefined;
  if (sub !== undefined) {
    // Finite YAML cannot recurse, but an alias can point an entry back at one
    // of its own ancestors — which would never terminate.
    if (run.ancestors.has(entry)) {
      options?.failures?.push({
        reason: "nested-cycle",
        pointer: failureAnchor(entryPointer, projection, options),
        entry: name,
      });
      return {};
    }
    run.ancestors.add(entry);
    try {
      mapped = projectCollection(sub, `${entryPointer}/${projection.nested}`, run);
    } finally {
      run.ancestors.delete(entry);
    }
  } else {
    const key = entry[projection.key];
    mapped =
      typeof key === "string"
        ? map[key]
        : referencedNode(key, name, entryPointer, projection, map, run.declaration, options);
  }
  // A value with no map entry projects to nothing rather than to `any`: the
  // vocabulary is the kind's own enum, so an unmapped value is a gap in the
  // kind's declaration, not a shape to guess at.
  if (!mapped) return undefined;
  const modifier = (field: string): unknown =>
    entry[field] !== undefined ? entry[field] : applicableDefault(run.defaultSites[field], entry);
  let node: Record<string, unknown> = { ...mapped };
  if (projection.array && modifier(projection.array) === true) {
    node = { type: "array", items: node };
  }
  if (projection.nullable && modifier(projection.nullable) !== false) {
    node = { anyOf: [node, { type: "null" }] };
  }
  return node;
}

/**
 * Project one declaration to an object schema.
 *
 * Modifiers are a CLOSED set applied in a FIXED order — `array` wraps, then
 * `nullable` widens. Closed because each changes how the schema is assembled,
 * so a third-party modifier would be a name nothing acts on; ordered because
 * leaving it implicit is how two implementations come to disagree. An entry
 * that omits one reads the `default:` that applies to IT — the field's own, or
 * the one the selected `then` / `else` of a conditional over the entry declares
 * — and with none declared `array` reads as false and `nullable` as true. `nested` recurses: an entry
 * carrying the sub-collection projects to the object it projects to.
 *
 * The projection is deliberately LOSSY. Length, precision, collation and check
 * constraints do not reach it: a consumer needs the type, its nullability and
 * its repetition, and the database enforces the rest. A per-entry schema rich
 * enough to double as a validator would move the domain's semantics into the
 * type layer.
 */
export function projectEntries(
  manifest: unknown,
  projection: SchemaProjection,
  map: SchemaMap,
  options?: ProjectOptions,
): Record<string, unknown> | undefined {
  const entries = navigate(manifest, projection.entries);
  if (entries === undefined) return undefined;
  return projectCollection(entries, projection.entries, {
    projection,
    map,
    options,
    defaultSites: modifierDefaultSitesOf(projection, options?.kindSchema),
    ancestors: new Set(),
    declaration: isObject(manifest) ? manifest : undefined,
  });
}

/** A reference as the analyzer sees it: the internal `{kind, name, alias?}`
 *  shape `resolveRefSentinels` rewrites `!ref` to. */
export interface ProjectionRef {
  readonly name: string;
  readonly kind?: string;
  readonly alias?: string;
}

/**
 * The `{kind, name, alias?}` reference a value holds, or undefined. Exported so
 * a host whose slot may hold EITHER shape can fall back to this reading.
 *
 * The unresolved `!ref` SENTINEL is read too. `resolveRefSentinels` normally
 * rewrites one before this pass, but not when the reference names nothing — and
 * that is exactly when a projection failure is reported, so reading only the
 * resolved shape made the diagnostic name the target `<unnamed>`, which is the
 * one fact the author needed from it. A round-trip host (`compile` off) carries
 * the sentinel for every reference, resolved or not.
 */
export function readProjectionRef(value: unknown): ProjectionRef | undefined {
  if (!isObject(value)) return undefined;
  if (isRefSentinel(value)) {
    const dot = value.source.indexOf(".");
    return dot > 0
      ? { name: value.source.slice(dot + 1), alias: value.source.slice(0, dot) }
      : { name: value.source };
  }
  const name = value.name;
  if (typeof name !== "string") return undefined;
  return {
    name,
    kind: typeof value.kind === "string" ? value.kind : undefined,
    alias: typeof value.alias === "string" ? value.alias : undefined,
  };
}

/**
 * Host-owned state one walk carries along its hops: the import each library was
 * entered through, keyed by the library's module. A library's resource INPUT is
 * a stand-in for what that import supplies, so the hop reaching one continues
 * to the supplied declaration. The kernel needs none — its library context
 * already holds the borrowed instance.
 */
export type ProjectionTrail = ReadonlyMap<string, Record<string, any>>;

/** What a reference resolved to. `"ambiguous"` is distinct from `undefined`
 *  because the two need different advice: one says disambiguate, the other says
 *  the name resolves to nothing. `"injected"` is a library's resource input
 *  whose supplier this walk did not enter through — answerable only where it is
 *  supplied. */
export type ProjectionLookup =
  | { readonly manifest: Record<string, any>; readonly trail?: ProjectionTrail }
  | { readonly ambiguous: true }
  | { readonly injected: true }
  | undefined;

/**
 * What projecting a consumer's slot needs: resolving a reference to the manifest
 * it names, the definition that manifest's `kind` names, and which of its paths
 * hold references.
 *
 * A RESOLVER rather than a list of manifests, because resolution is scoped and
 * only the host knows the scope: an alias-qualified `!ref Alias.users` names an
 * import's exported instance, and a bare name means the enclosing module's — a
 * distinction a name filter over one flattened list erases, which is how an
 * unambiguous cross-module reference came to read as ambiguous. It is also what
 * lets the kernel supply its own context lookup, so the contract the analyzer
 * types and the contract the kernel enforces are the same schema.
 *
 * **Every hop resolves in the scope of the module that declared the HOLDER** —
 * the declaration the reference is written in, which past the first hop is not
 * the consumer: a library's `node` naming `!ref users` means the library's
 * `users`, whoever projects through it.
 */
export interface ProjectionScope {
  /**
   * The declaration the value at a projected slot names, resolved in the scope
   * of the module that declared `holder`.
   *
   * Takes the RAW slot value rather than a parsed reference, because what sits
   * there depends on the host and only the host can read it: the analyzer sees
   * the `{kind, name, alias?}` reference the loader produced, while the kernel
   * binds contracts AFTER Phase-5 injection has replaced that reference with the
   * live instance. Parsing it here would have hardcoded the analyzer's shape and
   * left the kernel unable to resolve anything — which is a contract enforced
   * statically and not at dispatch.
   */
  resolveManifest(
    value: unknown,
    holder?: Record<string, any>,
    trail?: ProjectionTrail,
  ): ProjectionLookup;
  /** The definition a declaration's kind names, resolved in the module scope of
   *  `declaration`. */
  resolveDefinition(kind: string, declaration?: Record<string, any>): Record<string, any> | undefined;
  /**
   * The concrete reference sites of `declaration` — the sites Phase-5 injection
   * substitutes, `x-telo-schema-from` expansions included, spelled `tables[0]`
   * / `mounts[1].mount` / `tables.orders` — with its kind resolved in the
   * module scope of `scope` (the declaration itself, or the one an inline
   * declaration is written in). Undefined when the kind resolves to no
   * definition. The ONLY thing that decides whether a value is a reference.
   */
  referenceSlots(
    declaration: Record<string, any>,
    scope: Record<string, any>,
  ): readonly string[] | undefined;
  /** True for a value the host holds in place of a reference — the kernel's
   *  injected instance. Read only at a reference slot. */
  isLiveReference?(value: unknown): boolean;
  /** The declaration as its author wrote it, where the host holds an expanded
   *  copy — so a selector landing on a computed value is recognised whether or
   *  not it has been evaluated yet. */
  authored?(declaration: Record<string, any>): Record<string, any>;
}

/** How the flattened list is read past its own manifests: which module an alias
 *  names in the scope of the module that wrote it, a declaration's reference
 *  slots, and each imported library's own declarations. */
export interface ProjectionModules {
  moduleForAlias(module: string | undefined, alias: string): string | undefined;
  /** See {@link ProjectionScope.referenceSlots}. */
  referenceSlots(declaration: Record<string, any>, module: string | undefined): readonly string[] | undefined;
  readonly libraries?: LibraryDeclarations;
}

const moduleOf = (manifest: Record<string, any> | undefined): string | undefined => {
  const module = (manifest?.metadata as { module?: unknown } | undefined)?.module;
  return typeof module === "string" ? module : undefined;
};

/** The module whose scope a declaration's own references are written in: the
 *  owner of a re-exported copy, which is stamped under the re-exporting module. */
const scopeModuleOf = (manifest: Record<string, any> | undefined): string | undefined => {
  const declaring = (manifest?.metadata as { declaringModule?: unknown } | undefined)?.declaringModule;
  return typeof declaring === "string" ? declaring : moduleOf(manifest);
};

/**
 * The resolver for a FLATTENED manifest list — the analyzer's own shape.
 *
 * A reference resolves in the HOLDER's module, read off the `metadata.module`
 * stamp: a bare name among that module's declarations in the flat set, then
 * among the library's own documents; an alias through that module's own import
 * table, into the target module the same way. So two libraries each declaring a
 * `users` stay distinguishable at any hop, internal or exported. A holder with
 * no stamp resolves among the unstamped manifests, as one scope. A name the
 * holder's scope does not declare resolves to nothing — never to another
 * module's resource of the same name.
 *
 * A library's resource INPUT continues to what the import the walk entered the
 * library through supplies for it, resolved in the importing module's scope.
 */
export function manifestListScope(
  manifests: readonly Record<string, any>[],
  resolveDefinition: (kind: string, declaration?: Record<string, any>) => Record<string, any> | undefined,
  modules?: ProjectionModules,
): ProjectionScope {
  const libraries = modules?.libraries;
  const named = (name: string, module: string | undefined, kind?: string): Record<string, any>[] =>
    manifests.filter(
      (candidate) =>
        (candidate?.metadata as { name?: unknown } | undefined)?.name === name &&
        moduleOf(candidate) === module &&
        (kind === undefined || candidate.kind === kind),
    );

  const scope: ProjectionScope = {
    resolveDefinition,
    referenceSlots: (declaration, holder) =>
      modules?.referenceSlots(declaration, scopeModuleOf(declaration) ?? scopeModuleOf(holder)),
    resolveManifest(value, holder, trail) {
      const ref = readProjectionRef(value);
      if (!ref) return undefined;
      const module = scopeModuleOf(holder);
      if (ref.alias && ref.alias !== "Self") {
        const target = modules?.moduleForAlias(module, ref.alias);
        if (target === undefined) return undefined;
        const entry = named(ref.alias, module, "Telo.Import")[0] ??
          (module !== undefined ? libraries?.importOf(module, ref.alias) : undefined);
        const entered = entry ? new Map(trail).set(target, entry) : trail;
        return declaredIn(ref.name, target, entered);
      }
      return declaredIn(ref.name, module, trail);
    },
  };

  /** `name` among `module`'s declarations: the flat set, then the library's own
   *  documents, then its resource inputs. Undefined when none declares it. */
  function declaredIn(
    name: string,
    module: string | undefined,
    trail: ProjectionTrail | undefined,
  ): ProjectionLookup {
    const own = named(name, module);
    if (own.length > 1) return { ambiguous: true };
    if (own.length === 1) {
      return isInjectedDeclaration(own[0] as ResourceManifest)
        ? supplied(name, module, trail)
        : { manifest: own[0]!, trail };
    }
    if (module === undefined || !libraries) return undefined;
    if (libraries.isInput(module, name)) return supplied(name, module, trail);
    const internal = libraries.declaration(module, name);
    return internal ? { manifest: internal, trail } : undefined;
  }

  /** What the import the walk entered `module` through supplies for its input. */
  function supplied(
    name: string,
    module: string | undefined,
    trail: ProjectionTrail | undefined,
  ): ProjectionLookup {
    const entry = module === undefined ? undefined : trail?.get(module);
    if (!entry) return { injected: true };
    const value = readSuppliedResources(entry)[name];
    return value === undefined ? undefined : scope.resolveManifest(value, entry, trail);
  }

  return scope;
}

/** Where a hop past the consumer's own declaration stopped: the pointer prefix
 *  walked inside the declaration holding the value there. */
export interface ProjectionHop {
  readonly prefix: string;
  readonly holder: string;
}

/**
 * Why a slot could not be typed from a projection.
 *
 * Each reason is a DIFFERENT repair, which is why the three ways a target can
 * carry no usable projection are kept apart rather than collapsed into
 * `no-projection`: that one message ("declares no 'x-telo-schema-projection'")
 * was printed for a kind that declares one whose key field carries no map, and
 * for a declaration whose entry collection is simply absent — accusing the wrong
 * author of the wrong omission in both.
 *
 * `pointer` is always a path in the CONSUMER, where the diagnostic anchors; a
 * failure past the first hop names where it stopped in `via`.
 */
export type ProjectionFailure =
  | { readonly reason: "no-ref"; readonly pointer: string; readonly via?: ProjectionHop }
  | {
      readonly reason: "unresolved";
      readonly pointer: string;
      readonly name: string;
      readonly via?: ProjectionHop;
    }
  | {
      readonly reason: "ambiguous";
      readonly pointer: string;
      readonly name: string;
      readonly via?: ProjectionHop;
    }
  /** A declaration the walk reached has a kind that resolves to no definition,
   *  so which of its paths hold references is not known. */
  | {
      readonly reason: "no-definition";
      readonly pointer: string;
      readonly kind: string;
      readonly via?: ProjectionHop;
    }
  /** The target's KIND declares no `x-telo-schema-projection` at all. */
  | { readonly reason: "no-projection"; readonly pointer: string; readonly kind: string }
  /** It declares one, but the field it keys on carries no `x-telo-schema-map`. */
  | { readonly reason: "no-projection-map"; readonly pointer: string; readonly kind: string }
  /** Both are declared and the DECLARATION holds no entry collection to project
   *  — an absent `columns:`, or a value that is not a collection. */
  | {
      readonly reason: "no-entries";
      readonly pointer: string;
      readonly kind: string;
      readonly entries: string;
    }
  /** The slot names a resource the module does not DECLARE — a library's
   *  `resources:` input, standing in for an instance its importer supplies. A
   *  projection is DECLARATION-derived, so it cannot be answered in the
   *  library's own pass, which does not hold the import; the stand-in has no
   *  entries, and reporting that would tell the library author their block is
   *  wrong when it is correct. Carried as its own reason rather than as
   *  `no-entries` so a consumer can tell "unanswerable here" from "answered,
   *  and empty". */
  | {
      readonly reason: "injected";
      readonly pointer: string;
      readonly name: string;
      readonly via?: ProjectionHop;
    }
  /** An ENTRY of the projected declaration references a shape that could not be
   *  read. Reported rather than dropped: the entry would silently vanish from
   *  the projected row, so a consumer naming it would be told the property does
   *  not exist. */
  | {
      readonly reason: "entry-reference";
      readonly pointer: string;
      readonly entry: string;
      readonly name: string;
    }
  /** An entry's `nested` sub-collection leads back to the entry itself (a YAML
   *  alias), so projecting it would never terminate. It projects open. */
  | { readonly reason: "nested-cycle"; readonly pointer: string; readonly entry: string }
  /** The annotation is malformed — at the slot, or on the kind document a hop
   *  reached. Reported where it is written, as `SCHEMA_PROJECTION_INVALID`. */
  | { readonly reason: "invalid"; readonly pointer: string; readonly detail: string }
  /** Kind-document derivations lead back to a declaration already on the path. */
  | { readonly reason: "cycle"; readonly pointer: string; readonly holder: string }
  /** A `pick` / `omit` pointer lands on a value an expression computes. */
  | { readonly reason: "selector-computed"; readonly pointer: string; readonly selector: string }
  /** A `pick` / `omit` pointer lands on no entry name at all. */
  | { readonly reason: "selector-unset"; readonly pointer: string; readonly selector: string }
  /** A `pick` / `omit` pointer names an entry the projection does not have. */
  | {
      readonly reason: "selector-entry";
      readonly pointer: string;
      readonly selector: string;
      readonly entry: string;
    };

/** Failures the analyzer does not report at the consuming slot: `injected` is
 *  unanswerable in the library's own pass, and `invalid` is reported where the
 *  annotation is written. The kernel refuses both. */
export function isReportedAtConsumer(failure: ProjectionFailure): boolean {
  return failure.reason !== "injected" && failure.reason !== "invalid";
}

/** Failures travel beside schemas through the resolution; neither a projected
 *  object nor a mapped node carries a `reason` keyword. */
function isFailure(value: unknown): value is ProjectionFailure {
  return isObject(value) && typeof value.reason === "string" && typeof value.pointer === "string";
}

function isComputed(value: unknown): boolean {
  return isCompiledValue(value) || (isTaggedSentinel(value) && !isRefSentinel(value));
}

const nameOf = (manifest: Record<string, any>): string =>
  String((manifest.metadata as { name?: unknown } | undefined)?.name ?? `the inline ${manifest.kind}`);

/** A declaration the walk stands in: `scope` is the declaration whose module its
 *  names resolve in — itself, or the declaration an inline one is written in. */
interface Holder {
  readonly declaration: Record<string, any>;
  readonly scope: Record<string, any>;
  readonly trail?: ProjectionTrail;
}

/** One derivation being resolved: the consumer every failure anchors in. */
interface Derivation {
  readonly scope: ProjectionScope;
  readonly consumer: Record<string, any>;
}

interface Walked {
  readonly value: unknown;
  readonly holder: Holder;
  /** The segments walked inside the holder. */
  readonly inner: readonly string[];
  /** Whether the value sits at one of the holder's reference slots. */
  readonly atReference: boolean;
  /** The consumer-side path the walk left the consumer through. */
  readonly anchor: string;
}

function hopOf(holder: Holder, inner: readonly string[], run: Derivation): ProjectionHop | undefined {
  return holder.declaration === run.consumer
    ? undefined
    : { prefix: `/${inner.join("/")}`, holder: nameOf(holder.declaration) };
}

/** What a value at a reference slot IS: a reference in either spelling or a live
 *  instance, an inline declaration, or data the slot's value branch holds. */
function referenceValueKind(value: unknown, run: Derivation): "reference" | "inline" | "data" {
  if (run.scope.isLiveReference?.(value) === true || isRefSentinel(value)) return "reference";
  if (!isObject(value) || typeof value.kind !== "string") return "data";
  return typeof value.name === "string" ? "reference" : "inline";
}

/** The declaration the value at a reference slot of `holder` names, as the next
 *  holder. */
function followReference(
  value: unknown,
  holder: Holder,
  inner: readonly string[],
  anchor: string,
  run: Derivation,
): Holder | ProjectionFailure {
  const via = hopOf(holder, inner, run);
  const hop = via ? { via } : {};
  const kind = referenceValueKind(value, run);
  if (kind === "data") return { reason: "no-ref", pointer: anchor, ...hop };
  if (kind === "inline") {
    return { declaration: value as Record<string, any>, scope: holder.scope, trail: holder.trail };
  }
  const name = readProjectionRef(value)?.name ?? "<unnamed>";
  const found = run.scope.resolveManifest(value, holder.scope, holder.trail);
  if (!found) return { reason: "unresolved", pointer: anchor, name, ...hop };
  if ("ambiguous" in found) return { reason: "ambiguous", pointer: anchor, name, ...hop };
  if ("injected" in found || isInjectedDeclaration(found.manifest as ResourceManifest)) {
    return { reason: "injected", pointer: anchor, name, ...hop };
  }
  if (typeof found.manifest.kind !== "string") return { reason: "unresolved", pointer: anchor, name, ...hop };
  return { declaration: found.manifest, scope: found.manifest, trail: found.trail };
}

/** The field-map spelling of a path walked inside a holder: `routes[0].handler`. */
function concretePath(segments: readonly string[], containers: readonly unknown[]): string {
  let out = "";
  segments.forEach((segment, index) => {
    if (Array.isArray(containers[index])) out += `[${segment}]`;
    else out = out === "" ? segment : `${out}.${segment}`;
  });
  return out;
}

/**
 * Walk `pointer` from `start`. The HOLDER'S REFERENCE SITES decide where a
 * reference is: a segment after a value at one of its reference sites continues
 * inside the declaration that value names, to any depth — each one resolved in
 * the scope of the module that declared the declaration holding it. At any other
 * path a value is data, whatever its shape.
 */
function walk(
  start: Holder,
  pointer: string,
  anchor: string | undefined,
  run: Derivation,
): Walked | ProjectionFailure {
  let holder = start;
  let value: unknown = start.declaration;
  let prefix = "";
  let inner: string[] = [];
  let containers: unknown[] = [];
  let atReference = false;
  let left = anchor;
  let slots = referenceSlotsOf(holder, [], run, left ?? "");
  if (isFailure(slots)) return slots;
  for (const segment of decodePointer(pointer)) {
    if (atReference) {
      left ??= prefix;
      const next = followReference(value, holder, inner, left, run);
      if (isFailure(next)) return next;
      holder = next;
      value = next.declaration;
      inner = [];
      containers = [];
      slots = referenceSlotsOf(holder, inner, run, left);
      if (isFailure(slots)) return slots;
    }
    if (!isObject(value) && !Array.isArray(value)) {
      const via = hopOf(holder, inner, run);
      return { reason: "no-ref", pointer: left ?? prefix, ...(via ? { via } : {}) };
    }
    containers.push(value);
    value = (value as Record<string, unknown>)[segment];
    prefix = `${prefix}/${segment}`;
    inner.push(segment);
    const concrete = concretePath(inner, containers);
    atReference = slots.includes(concrete);
  }
  return { value, holder, inner, atReference, anchor: left ?? prefix };
}

/** A value a location reaches, and the declaration it is written in. */
export interface DeclarationValue {
  readonly value: unknown;
  readonly holder: Record<string, any>;
}

/**
 * Every value `segments` reaches from `consumer`, by the rule {@link walk}
 * follows: a segment after a value at one of the holder's reference sites
 * continues inside the declaration that value names, resolved in the scope of
 * the module that declared the holder. A `*` segment ranges over every item of a
 * list. A branch that reaches nothing — an absent field, a reference that does
 * not resolve here, a library's resource input — contributes nothing.
 */
export function declarationValuesAt(
  consumer: Record<string, any>,
  segments: readonly string[],
  scope: ProjectionScope,
): DeclarationValue[] {
  const run: Derivation = { scope, consumer };
  const out: DeclarationValue[] = [];
  const start: Holder = { declaration: consumer, scope: consumer };
  // A consumer whose reference sites cannot be read still holds its own fields:
  // nothing in it is crossed, and every path is read as data.
  const ownSlots = referenceSlotsOf(start, [], run, "");
  const slots = isFailure(ownSlots) ? [] : ownSlots;

  const reach = (
    holder: Holder,
    value: unknown,
    inner: readonly string[],
    containers: readonly unknown[],
    holderSlots: readonly string[],
    atReference: boolean,
    rest: readonly string[],
  ): void => {
    if (rest.length === 0) {
      if (value !== undefined) out.push({ value, holder: holder.declaration });
      return;
    }
    if (atReference) {
      const next = followReference(value, holder, inner, "", run);
      if (isFailure(next)) return;
      const nextSlots = referenceSlotsOf(next, [], run, "");
      if (isFailure(nextSlots)) return;
      reach(next, next.declaration, [], [], nextSlots, false, rest);
      return;
    }
    const [segment, ...tail] = rest;
    const into = (key: string): void => {
      const nextInner = [...inner, key];
      const nextContainers = [...containers, value];
      reach(
        holder,
        (value as Record<string, unknown>)[key],
        nextInner,
        nextContainers,
        holderSlots,
        holderSlots.includes(concretePath(nextInner, nextContainers)),
        tail,
      );
    };
    if (segment === "*") {
      if (Array.isArray(value)) value.forEach((item, index) => into(String(index)));
      return;
    }
    if (isObject(value)) into(segment!);
  };

  reach(start, consumer, [], [], slots, false, segments);
  return out;
}

function referenceSlotsOf(
  holder: Holder,
  inner: readonly string[],
  run: Derivation,
  anchor: string,
): readonly string[] | ProjectionFailure {
  const slots = run.scope.referenceSlots(holder.declaration, holder.scope);
  if (slots) return slots;
  const via = hopOf(holder, inner, run);
  return {
    reason: "no-definition",
    pointer: anchor,
    kind: String(holder.declaration.kind),
    ...(via ? { via } : {}),
  };
}

/** The declaration `pointer` names, relative to `holder`; the empty pointer is
 *  `holder` itself. */
function derivedTarget(
  holder: Holder,
  pointer: string,
  anchor: string | undefined,
  run: Derivation,
): { holder: Holder; anchor: string } | ProjectionFailure {
  if (pointer === "") return { holder, anchor: anchor ?? "" };
  const walked = walk(holder, pointer, anchor, run);
  if (isFailure(walked)) return walked;
  if (!walked.atReference) {
    const via = hopOf(walked.holder, walked.inner, run);
    return { reason: "no-ref", pointer: walked.anchor, ...(via ? { via } : {}) };
  }
  const next = followReference(walked.value, walked.holder, walked.inner, walked.anchor, run);
  return isFailure(next) ? next : { holder: next, anchor: walked.anchor };
}

/** The entry name a `pick` / `omit` pointer selects. */
function selectedEntry(
  holder: Holder,
  selector: string,
  anchor: string,
  run: Derivation,
): string | ProjectionFailure {
  const walked = walk(holder, selector, holder.declaration === run.consumer ? undefined : anchor, run);
  if (isFailure(walked)) return walked;
  const written = run.scope.authored?.(walked.holder.declaration) ?? walked.holder.declaration;
  let authored: unknown = written;
  for (const segment of walked.inner) {
    authored = isObject(authored) || Array.isArray(authored) ? (authored as any)[segment] : undefined;
  }
  if (isComputed(authored) || isComputed(walked.value)) {
    return { reason: "selector-computed", pointer: walked.anchor, selector };
  }
  if (typeof walked.value !== "string") {
    return { reason: "selector-unset", pointer: walked.anchor, selector };
  }
  return walked.value;
}

function entriesOf(projected: Record<string, unknown>): Record<string, unknown> {
  return isObject(projected.properties) ? projected.properties : {};
}

function withoutEntries(
  projected: Record<string, unknown>,
  holder: Holder,
  selectors: readonly string[] | undefined,
  anchor: string,
  run: Derivation,
): Record<string, unknown> | ProjectionFailure {
  if (!selectors || selectors.length === 0) return projected;
  const entries = { ...entriesOf(projected) };
  for (const selector of selectors) {
    const entry = selectedEntry(holder, selector, anchor, run);
    if (typeof entry !== "string") return entry;
    if (!Object.hasOwn(entries, entry)) {
      return { reason: "selector-entry", pointer: anchor, selector, entry };
    }
    delete entries[entry];
  }
  return { ...projected, properties: entries };
}

/**
 * Project one declaration: through its kind's own `x-telo-schema-projection`, or
 * through the derivation its kind DOCUMENT declares — typed exactly as if the
 * consumer had pointed at the derived target, less what that derivation omits.
 */
function projectDeclaration(
  holder: Holder,
  anchor: string,
  run: Derivation,
  failures: ProjectionFailure[] | undefined,
  path: Set<object>,
): Record<string, unknown> | ProjectionFailure | undefined {
  const declaration = holder.declaration;
  if (typeof declaration.kind !== "string") return { reason: "no-ref", pointer: "" };
  const kind = declaration.kind;
  const definition = run.scope.resolveDefinition(kind, holder.scope);
  if (!definition) return { reason: "no-projection", pointer: anchor, kind };

  const derived = readKindDerivation(definition);
  if (derived && "invalid" in derived) {
    return { reason: "invalid", pointer: anchor, detail: `kind '${kind}': ${derived.invalid}` };
  }
  if (derived) {
    if (path.has(declaration)) return { reason: "cycle", pointer: anchor, holder: nameOf(declaration) };
    path.add(declaration);
    const target = derivedTarget(holder, derived.derivation.from, anchor, run);
    if (isFailure(target)) return target;
    const projected = projectDeclaration(target.holder, anchor, run, failures, path);
    if (!projected || isFailure(projected)) return projected;
    return withoutEntries(projected, holder, derived.derivation.omit, anchor, run);
  }

  const projection = readSchemaProjection(definition);
  const map = projection && projectionKeyMap(definition.schema, projection);
  // The EMPTY pointer names the declaration itself, whose entry paths are its
  // own; any other declaration's entries are anchored at the consumer's slot.
  const pointer = declaration === run.consumer ? "" : anchor === "" ? "/" : anchor;
  const projected =
    projection && map
      ? projectEntries(declaration, projection, map, {
          scope: run.scope,
          pointer,
          failures,
          kindSchema: definition.schema,
        })
      : undefined;
  if (projected) return projected;
  // Three distinct omissions, three repairs by three different authors: the
  // kind declares no projection, the kind declares one the key field has no
  // vocabulary for, or this DECLARATION simply lists no entries.
  if (!projection) return { reason: "no-projection", pointer: anchor, kind };
  if (!map) return { reason: "no-projection-map", pointer: anchor, kind };
  return { reason: "no-entries", pointer: anchor, kind, entries: projection.entries };
}

/** The schema a consumer's derivation types its slot as. */
function projectDerivation(
  consumer: Record<string, any>,
  derivation: ProjectionDerivation,
  scope: ProjectionScope,
  failures: ProjectionFailure[] | undefined,
): Record<string, unknown> | ProjectionFailure | undefined {
  const run: Derivation = { scope, consumer };
  const start: Holder = { declaration: consumer, scope: consumer };
  const target = derivedTarget(start, derivation.from, undefined, run);
  if (isFailure(target)) return target;
  const projected = projectDeclaration(target.holder, target.anchor, run, failures, new Set());
  if (!projected || isFailure(projected)) return projected;
  const kept = withoutEntries(projected, start, derivation.omit, target.anchor, run);
  if (isFailure(kept) || derivation.pick === undefined) return kept;
  const entry = selectedEntry(start, derivation.pick, target.anchor, run);
  if (typeof entry !== "string") return entry;
  const entries = entriesOf(kept);
  if (!Object.hasOwn(entries, entry)) {
    return { reason: "selector-entry", pointer: target.anchor, selector: derivation.pick, entry };
  }
  return entries[entry] as Record<string, unknown>;
}

export function describeProjectionFailure(failure: ProjectionFailure): string {
  const subject = (via: ProjectionHop | undefined): string =>
    via
      ? `'${failure.pointer}' leads to '${via.prefix}' inside '${via.holder}', which`
      : `'${failure.pointer}'`;
  switch (failure.reason) {
    case "no-ref":
      return failure.pointer === "" && !failure.via
        ? "this resource declares no 'kind:', so there is no definition to project it through."
        : `${subject(failure.via)} does not hold a reference, so there is no declaration to project.`;
    case "unresolved":
      return `${subject(failure.via)} references '${failure.name}', which resolves to no resource.`;
    case "no-definition":
      return (
        `${subject(failure.via)} is a resource of kind '${failure.kind}', which resolves to no ` +
        `definition — so nothing says which of its fields hold references to continue through.`
      );
    case "injected":
      return (
        `${subject(failure.via)} references '${failure.name}', a resource input this module does ` +
        `not declare — its entries belong to whoever supplies it.`
      );
    case "ambiguous":
      return (
        `${subject(failure.via)} references '${failure.name}', which matches more than one ` +
        `resource in scope. Rename one of them so the reference names exactly one declaration.`
      );
    case "no-projection":
      return (
        `'${failure.pointer}' references a resource of kind '${failure.kind}', which declares no ` +
        `'x-telo-schema-projection' — so there is nothing for this slot to be typed from.`
      );
    case "no-projection-map":
      return (
        `kind '${failure.kind}' declares an 'x-telo-schema-projection' whose key field carries ` +
        `no 'x-telo-schema-map', so there is no vocabulary to project its entries through and ` +
        `'${failure.pointer || "this declaration"}' cannot be typed from it.`
      );
    case "no-entries":
      return (
        `'${failure.entries}' holds no entry collection on this ${failure.kind}, so the ` +
        `projection has nothing to type '${failure.pointer || "this declaration"}' from.`
      );
    case "entry-reference":
      return (
        `entry '${failure.entry}' at '${failure.pointer}' references '${failure.name}', which ` +
        `resolves to no declaration this analysis can read — so that entry is projected as an ` +
        `open value and nothing typed from it is checked against the shape it was meant to have.`
      );
    case "nested-cycle":
      return (
        `entry '${failure.entry}' at '${failure.pointer}' contains itself through its nested ` +
        `entries, so its projection would never end — it is projected as an open value. ` +
        `Replace the alias that points back at it with the entries themselves.`
      );
    case "invalid":
      return failure.detail;
    case "cycle":
      return (
        `'${failure.pointer}' is projected through kind-level derivations that lead back to ` +
        `'${failure.holder}', so it never reaches a declaration whose kind declares ` +
        `'x-telo-schema-projection'.`
      );
    case "selector-computed":
      return (
        `'${failure.selector}' names the entry to select, but the value there is computed by an ` +
        `expression. An entry is selected by a literal name, known before anything runs.`
      );
    case "selector-unset":
      return `'${failure.selector}' names the entry to select, but holds no entry name.`;
    case "selector-entry":
      return (
        `'${failure.selector}' names entry '${failure.entry}', which the projection of ` +
        `'${failure.pointer}' does not have.`
      );
  }
}

/**
 * Replace every `x-telo-schema-projection-from` node with the projection of the
 * declaration it derives.
 *
 * Structural: returns a new schema and never mutates the one handed in. A node
 * that cannot be projected is left exactly as it was — degrading to the slot's
 * own schema rather than to a wrong one — and the reason is pushed to
 * `failures`, because degrading SILENTLY is the failure this whole mechanism
 * exists to move earlier: the consumer's contract quietly reopens and a
 * misspelled field passes `telo check` exactly as it did before.
 *
 * **A node that projected NOTHING is returned by IDENTITY**, and that is a
 * correctness property of the caller rather than a micro-optimization:
 * `DefinitionRegistry` memoizes a compiled AJV validator per schema OBJECT,
 * because every resource of a kind is checked against the same one at keystroke
 * time. Rebuilding each node unconditionally — which this did — misses that memo
 * for every resource in the analysis, so AJV recompiled the whole kind schema
 * once per resource: on `apps/hub` that was 197 compiles instead of 54, and 723
 * ms instead of 97. Returning the input where nothing changed restores it for
 * every kind that declares no projection at all, which is nearly all of them.
 */
export function resolveSchemaProjections(
  schema: unknown,
  manifest: Record<string, any> | undefined,
  scope: ProjectionScope,
  failures?: ProjectionFailure[],
): unknown {
  if (Array.isArray(schema)) {
    let moved = false;
    const items = schema.map((item) => {
      const next = resolveSchemaProjections(item, manifest, scope, failures);
      if (next !== item) moved = true;
      return next;
    });
    return moved ? items : schema;
  }
  if (!isObject(schema)) return schema;

  const read = readProjectionDerivation(schema[PROJECTION_FROM]);
  if (read && manifest) {
    const projected =
      "invalid" in read
        ? ({ reason: "invalid", pointer: "", detail: read.invalid } as const)
        : projectDerivation(manifest, read.derivation, scope, failures);
    if (isFailure(projected)) {
      failures?.push(projected);
    } else if (projected) {
      const { [PROJECTION_FROM]: _dropped, ...rest } = schema;
      return { ...rest, ...projected };
    }
  }

  let moved = false;
  const entries = Object.entries(schema).map(([key, value]) => {
    const next = key.startsWith("x-telo-")
      ? value
      : resolveSchemaProjections(value, manifest, scope, failures);
    if (next !== value) moved = true;
    return [key, next] as const;
  });
  return moved ? Object.fromEntries(entries) : schema;
}

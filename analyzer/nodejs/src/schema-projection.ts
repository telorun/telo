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

import { isRefSentinel } from "@telorun/templating";

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

/** The consumer-side annotation: a JSON Pointer to this resource's ref slot
 *  whose target declares the projection. */
export function readProjectionFrom(node: unknown): string | undefined {
  if (!isObject(node)) return undefined;
  const raw = node["x-telo-schema-projection-from"];
  return typeof raw === "string" ? raw : undefined;
}

function navigate(root: unknown, pointer: string): unknown {
  let current: unknown = root;
  for (const segment of pointer.split("/")) {
    if (segment === "") continue;
    if (!isObject(current)) return undefined;
    current = current[segment];
  }
  return current;
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
  let node: unknown = kindSchema;
  for (const segment of projection.entries.split("/")) {
    if (segment === "") continue;
    if (!isObject(node) || !isObject(node.properties)) return undefined;
    node = node.properties[segment];
  }
  if (!isObject(node)) return undefined;
  const entry = isObject(node.additionalProperties)
    ? node.additionalProperties
    : isObject(node.items)
      ? node.items
      : undefined;
  if (!isObject(entry) || !isObject(entry.properties)) return undefined;
  return readSchemaMap(entry.properties[projection.key]);
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
  projection: SchemaProjection,
  map: SchemaMap,
  options?: {
    readonly scope?: ProjectionScope;
    readonly pointer?: string;
    readonly failures?: ProjectionFailure[];
  },
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
      // The EMPTY pointer means the projected declaration is the one carrying
      // the diagnostic, so the entry's own path is a real anchor in that file —
      // the column, not the document root. Any other pointer names a slot
      // holding a reference to a DIFFERENT manifest, whose entry paths mean
      // nothing here, so the slot stays the anchor.
      pointer:
        options?.pointer === ""
          ? `${projection.entries}/${entryName}`
          : (options?.pointer ?? projection.entries),
      entry: entryName,
      name,
    });
    return {};
  };
  const found = options?.scope?.resolveManifest(value);
  if (!found || "ambiguous" in found) return report();

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

/**
 * Project one declaration to an object schema.
 *
 * Modifiers are a CLOSED set applied in a FIXED order — `array` wraps, then
 * `nullable` widens. Closed because each changes how the schema is assembled,
 * so a third-party modifier would be a name nothing acts on; ordered because
 * leaving it implicit is how two implementations come to disagree.
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
  /** What a REFERENCE at the keyed field is resolved through, and where a
   *  failure to resolve one is reported. A caller with no scope cannot resolve
   *  one, so such an entry projects OPEN — present, untyped — rather than
   *  vanishing from the row. */
  options?: {
    readonly scope?: ProjectionScope;
    readonly pointer?: string;
    readonly failures?: ProjectionFailure[];
  },
): Record<string, unknown> | undefined {
  const entries = navigate(manifest, projection.entries);
  if (entries === undefined) return undefined;

  const pairs: [string, Record<string, unknown>][] = [];
  const consider = (name: string | undefined, entry: unknown): void => {
    if (!isObject(entry) || name === undefined) return;
    const key = entry[projection.key];
    const mapped =
      typeof key === "string"
        ? map[key]
        : referencedNode(key, name, projection, map, options);
    // A value with no map entry projects to nothing rather than to `any`: the
    // vocabulary is the kind's own enum, so an unmapped value is a gap in the
    // kind's declaration, not a shape to guess at.
    if (!mapped) return;
    let node: Record<string, unknown> = { ...mapped };
    if (projection.array && entry[projection.array] === true) {
      node = { type: "array", items: node };
    }
    if (projection.nullable && entry[projection.nullable] !== false) {
      node = { anyOf: [node, { type: "null" }] };
    }
    pairs.push([name, node]);
  };

  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const name = isObject(entry) && projection.nameField
        ? (entry[projection.nameField] as string | undefined)
        : undefined;
      consider(name, entry);
    }
  } else if (isObject(entries)) {
    for (const [name, entry] of Object.entries(entries)) consider(name, entry);
  } else {
    return undefined;
  }

  return {
    type: "object",
    properties: Object.fromEntries(pairs),
    additionalProperties: false,
  };
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

/** What a reference resolved to. `"ambiguous"` is distinct from `undefined`
 *  because the two need different advice: one says disambiguate, the other says
 *  the name resolves to nothing. */
export type ProjectionLookup =
  | { readonly manifest: Record<string, any> }
  | { readonly ambiguous: true }
  | undefined;

/**
 * What projecting a consumer's slot needs: resolving a reference to the manifest
 * it names, and the definition that manifest's `kind` names.
 *
 * A RESOLVER rather than a list of manifests, because resolution is scoped and
 * only the host knows the scope: an alias-qualified `!ref Alias.users` names an
 * import's exported instance, and a bare name means the enclosing module's — a
 * distinction a name filter over one flattened list erases, which is how an
 * unambiguous cross-module reference came to read as ambiguous. It is also what
 * lets the kernel supply its own context lookup, so the contract the analyzer
 * types and the contract the kernel enforces are the same schema.
 */
export interface ProjectionScope {
  /**
   * The declaration the value at a projected slot names.
   *
   * Takes the RAW slot value rather than a parsed reference, because what sits
   * there depends on the host and only the host can read it: the analyzer sees
   * the `{kind, name, alias?}` reference the loader produced, while the kernel
   * binds contracts AFTER Phase-5 injection has replaced that reference with the
   * live instance. Parsing it here would have hardcoded the analyzer's shape and
   * left the kernel unable to resolve anything — which is a contract enforced
   * statically and not at dispatch.
   */
  resolveManifest(value: unknown): ProjectionLookup;
  resolveDefinition(kind: string): Record<string, any> | undefined;
}

/**
 * The resolver for a FLATTENED manifest list — the analyzer's own shape.
 *
 * An alias narrows to the manifests forwarded from that import (stamped
 * `metadata.alias` by flatten), so two libraries each exporting a `users` table
 * stay distinguishable. Only when nothing carries the alias does it fall back to
 * matching by name alone, which is the pre-flatten shape a standalone module
 * analysis has.
 */
export function manifestListScope(
  manifests: readonly Record<string, any>[],
  resolveDefinition: (kind: string) => Record<string, any> | undefined,
): ProjectionScope {
  return {
    resolveDefinition,
    resolveManifest(value) {
      const ref = readProjectionRef(value);
      if (!ref) return undefined;
      const byName = manifests.filter(
        (candidate) =>
          (candidate?.metadata as { name?: unknown } | undefined)?.name === ref.name &&
          (typeof ref.kind !== "string" || candidate.kind === ref.kind),
      );
      const aliased =
        ref.alias && ref.alias !== "Self"
          ? byName.filter(
              (candidate) =>
                (candidate?.metadata as { alias?: unknown } | undefined)?.alias === ref.alias,
            )
          : byName;
      // A name that matches SEVERAL manifests is REFUSED rather than resolved to
      // the first: picking one by flatten order would type the consumer's rows
      // against the wrong declaration — a wrong answer, which is worse than no
      // answer. Reported, so the author is told to disambiguate.
      const matches = aliased.length > 0 ? aliased : byName;
      if (matches.length === 0) return undefined;
      if (matches.length > 1) return { ambiguous: true };
      return { manifest: matches[0]! };
    },
  };
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
 */
export type ProjectionFailure =
  | { readonly reason: "no-ref"; readonly pointer: string }
  | { readonly reason: "unresolved"; readonly pointer: string; readonly name: string }
  | { readonly reason: "ambiguous"; readonly pointer: string; readonly name: string }
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
  /** An ENTRY of the projected declaration references a shape that could not be
   *  read. Reported rather than dropped: the entry would silently vanish from
   *  the projected row, so a consumer naming it would be told the property does
   *  not exist. */
  | {
      readonly reason: "entry-reference";
      readonly pointer: string;
      readonly entry: string;
      readonly name: string;
    };

function refTarget(
  value: unknown,
  scope: ProjectionScope,
  pointer: string,
):
  | { manifest: Record<string, any>; definition: Record<string, any> }
  | ProjectionFailure {
  if (!isObject(value)) return { reason: "no-ref", pointer };
  const name = typeof value.name === "string" ? value.name : "<unnamed>";
  const found = scope.resolveManifest(value);
  if (!found) return { reason: "unresolved", pointer, name };
  if ("ambiguous" in found) return { reason: "ambiguous", pointer, name };
  const manifest = found.manifest;
  if (typeof manifest.kind !== "string") return { reason: "unresolved", pointer, name };
  const definition = scope.resolveDefinition(manifest.kind);
  if (!definition) return { reason: "no-projection", pointer, kind: manifest.kind };
  return { manifest, definition };
}

/** The declaration the annotation is written on, as a projection target. */
function ownTarget(
  manifest: Record<string, any>,
  scope: ProjectionScope,
): { manifest: Record<string, any>; definition: Record<string, any> } | ProjectionFailure {
  if (typeof manifest.kind !== "string") {
    return { reason: "no-ref", pointer: "" };
  }
  const definition = scope.resolveDefinition(manifest.kind);
  if (!definition) return { reason: "no-projection", pointer: "", kind: manifest.kind };
  return { manifest, definition };
}

export function describeProjectionFailure(failure: ProjectionFailure): string {
  switch (failure.reason) {
    case "no-ref":
      return failure.pointer === ""
        ? "this resource declares no 'kind:', so there is no definition to project it through."
        : `'${failure.pointer}' does not hold a reference, so there is no declaration to project.`;
    case "unresolved":
      return `'${failure.pointer}' references '${failure.name}', which resolves to no resource.`;
    case "ambiguous":
      return (
        `'${failure.pointer}' references '${failure.name}', which matches more than one resource ` +
        `in scope. Rename one of them so the reference names exactly one declaration.`
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
  }
}

/**
 * Replace every `x-telo-schema-projection-from` node with the projection of the
 * declaration it points at.
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

  const pointer = readProjectionFrom(schema);
  if (pointer !== undefined && manifest) {
    // The EMPTY pointer names the declaration this annotation is written on,
    // rather than a slot holding a reference to another. Resolution is skipped
    // because the declaration is already in hand — which is what lets a kind
    // type its own data against its own entries (a table's seed rows against its
    // columns), something no reference could reach.
    const target =
      pointer === ""
        ? ownTarget(manifest, scope)
        : refTarget(navigate(manifest, pointer), scope, pointer);
    if ("reason" in target) {
      failures?.push(target);
    } else {
      const kind = String(target.manifest.kind ?? "<unknown>");
      const projection = readSchemaProjection(target.definition);
      const map = projection && projectionKeyMap(target.definition.schema, projection);
      const projected =
        projection && map
          ? projectEntries(target.manifest, projection, map, { scope, pointer, failures })
          : undefined;
      if (projected) {
        const { ["x-telo-schema-projection-from"]: _dropped, ...rest } = schema;
        return { ...rest, ...projected };
      }
      // Three distinct omissions, three repairs by three different authors: the
      // kind declares no projection, the kind declares one the key field has no
      // vocabulary for, or this DECLARATION simply lists no entries.
      if (!projection) failures?.push({ reason: "no-projection", pointer, kind });
      else if (!map) failures?.push({ reason: "no-projection-map", pointer, kind });
      else {
        failures?.push({ reason: "no-entries", pointer, kind, entries: projection.entries });
      }
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

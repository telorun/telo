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

export function readSchemaMap(node: unknown): SchemaMap | undefined {
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
): Record<string, unknown> | undefined {
  const entries = navigate(manifest, projection.entries);
  if (entries === undefined) return undefined;

  const pairs: [string, Record<string, unknown>][] = [];
  const consider = (name: string | undefined, entry: unknown): void => {
    if (!isObject(entry) || name === undefined) return;
    const key = entry[projection.key];
    const mapped = typeof key === "string" ? map[key] : undefined;
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

/** The `{kind, name, alias?}` reference a value holds, or undefined. Exported so
 *  a host whose slot may hold EITHER shape can fall back to this reading. */
export function readProjectionRef(value: unknown): ProjectionRef | undefined {
  if (!isObject(value)) return undefined;
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

export type ProjectionFailure =
  | { readonly reason: "no-ref"; readonly pointer: string }
  | { readonly reason: "unresolved"; readonly pointer: string; readonly name: string }
  | { readonly reason: "ambiguous"; readonly pointer: string; readonly name: string }
  | { readonly reason: "no-projection"; readonly pointer: string; readonly kind: string };

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

export function describeProjectionFailure(failure: ProjectionFailure): string {
  switch (failure.reason) {
    case "no-ref":
      return `'${failure.pointer}' does not hold a reference, so there is no declaration to project.`;
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
 */
export function resolveSchemaProjections(
  schema: unknown,
  manifest: Record<string, any> | undefined,
  scope: ProjectionScope,
  failures?: ProjectionFailure[],
): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => resolveSchemaProjections(item, manifest, scope, failures));
  }
  if (!isObject(schema)) return schema;

  const pointer = readProjectionFrom(schema);
  if (pointer && manifest) {
    const target = refTarget(navigate(manifest, pointer), scope, pointer);
    if ("reason" in target) {
      failures?.push(target);
    } else {
      const projection = readSchemaProjection(target.definition);
      const map = projection && projectionKeyMap(target.definition.schema, projection);
      const projected =
        projection && map ? projectEntries(target.manifest, projection, map) : undefined;
      if (projected) {
        const { ["x-telo-schema-projection-from"]: _dropped, ...rest } = schema;
        return { ...rest, ...projected };
      }
      failures?.push({
        reason: "no-projection",
        pointer,
        kind: String(target.manifest.kind ?? "<unknown>"),
      });
    }
  }

  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      key.startsWith("x-telo-") ? value : resolveSchemaProjections(value, manifest, scope, failures),
    ]),
  );
}

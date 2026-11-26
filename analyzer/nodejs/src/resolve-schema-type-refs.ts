import type { ResourceDefinition } from "@telorun/sdk";
import { inheritSchemaPlaces } from "./schema-provenance.js";
import { recordAuthoredSchemaRef } from "./authored-schema-refs.js";
import { inheritedCapability } from "./extends-resolution.js";
import type { ResourceManifest } from "@telorun/sdk";
import { canonicalTypeSchemaId, parseCanonicalTypeSchemaId, parseTeloTypeRef } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { isTaggedSentinel } from "@telorun/templating";
import { definitionInScope, moduleAliasScope } from "./module-alias-scope.js";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import { schemaReferenceParts } from "./schema-reference.js";
import { isResolvedReference, RESOLVED_REFERENCE_MARKER } from "./resolved-reference.js";
import { withCanonicalAnnotationKinds } from "./resolve-schema-ref-kinds.js";
import { isModuleKind } from "./module-kinds.js";

/** Schema-bearing fields on a Telo.Definition / Telo.Type resource. */
const SCHEMA_FIELDS = ["schema", "inputType", "outputType"];

/** A callable's signature. Walked separately because neither is itself a
 *  reference SLOT — the shapes sit one level in, at `params[].schema` and
 *  `returns.schema` — so a reference there is rewritten outright rather than
 *  kept with the canonical id stamped beside it. */
const SIGNATURE_FIELDS = ["params", "returns"];

/**
 * Rewrites schema references to their canonical, module-scoped form, in place.
 *
 * A named shape is written with the reference tag — `!ref File` for the declaring
 * module's own, `!ref <Alias>.<File>` for one an imported library exports — which
 * is Telo's ONE reference grammar, and `use: schema` has been in the `x-telo-ref`
 * vocabulary for exactly this relation all along (*names a shape; no runtime
 * instance, no edge*). Phase 2.5 has already turned the tag into `{kind, name,
 * alias?}`; this pass turns that into `{ $ref: "telo:<module>/<type>" }`, the id
 * the type registered its schema under.
 *
 * WHY NORMALIZE RATHER THAN RESOLVE. Substituting the shape itself would inline
 * it, which changes schema identity — the compiled-validator cache is keyed on it
 * — and would make a self-recursive shape inexpressible. Keeping a REFERENCE is
 * what every validator wants, and it is not an AJV concern: a Rust validator
 * wants a registered id just as much. So the tag is the authoring surface and the
 * canonical `$ref` is the internal form, exactly as `resolveRefSentinels`
 * already splits authoring sugar from canonical form.
 *
 * ALIAS SCOPE IS WHAT THE CANONICAL FORM CARRIES. The authority is resolved in
 * the DECLARING module's scope, so the id names the owning module and two
 * libraries declaring a shape of the same name stay distinct. A downstream
 * resolver reads the module off the id instead of matching a bare name, which is
 * how an alias used to get silently dropped.
 *
 * The legacy authoring spelling `$ref: "telo://<authority>/<type>"` is resolved
 * the same way, since a published artifact carries it. The version lives on the
 * `imports:` entry, never the URI — only the pinned version is loaded, so the
 * canonical id is version-free; a JSON Pointer into a shape
 * (`telo://Self/<type>#/properties/x`) keeps its pointer. Already-canonical refs
 * and fragment-bearing built-ins (`telo://manifest#/$defs/ResourceRef`) are left
 * untouched: the former because the authority resolves to nothing, the latter
 * because they do not match the `authority/type` grammar.
 */
export function resolveSchemaTypeRefs(
  resources: ResourceManifest[],
  aliases?: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
  /** The definitions a reference's kind resolves to. With them every other field's
   *  references to a named shape get the canonical id stamped beside them too. */
  defs?: ShapeKindSource,
): void {
  for (const r of resources) {
    const ownModule = (r.metadata as { module?: string } | undefined)?.module;
    const resolver = moduleAliasScope(r.metadata, aliases, aliasesByModule);
    const resolveAuthority = (authority: string): string | undefined =>
      authority === "Self" ? ownModule : resolver?.moduleForAlias(authority);
    for (const field of SCHEMA_FIELDS) {
      canonicalizeInPlace((r as Record<string, unknown>)[field], resolveAuthority, ownModule, true);
    }
    for (const field of SIGNATURE_FIELDS) {
      canonicalizeInPlace((r as Record<string, unknown>)[field], resolveAuthority, ownModule, false);
    }
    // A module document's `variables:` / `secrets:` entries are schemas, read
    // in the module the document declares.
    if (isModuleKind(r.kind)) {
      const declared = ownModule ?? (r.metadata as { name?: string } | undefined)?.name;
      const authority = (name: string) => (name === "Self" ? declared : resolver?.moduleForAlias(name));
      for (const field of ["variables", "secrets"]) {
        const block = (r as Record<string, unknown>)[field];
        if (!block || typeof block !== "object" || Array.isArray(block)) continue;
        for (const entry of Object.values(block)) canonicalizeInPlace(entry, authority, declared, false);
      }
    }
    if (!defs) continue;
    const namesShape = (kind: string): boolean =>
      inheritedCapability(definitionInScope(defs, kind, r.metadata, aliases, aliasesByModule), (k) => defs.resolve(k)) === "Telo.Type";
    for (const [field, value] of Object.entries(r)) {
      if (field === "kind" || field === "metadata" || SCHEMA_FIELDS.includes(field) || SIGNATURE_FIELDS.includes(field)) {
        continue;
      }
      stampShapeReferences(value, resolveAuthority, ownModule, namesShape);
    }
  }
}

/**
 * The copy of `definition` the registry holds, derived in the scope of the
 * module that DECLARED it, read off the writer's alias scope alone — never by
 * looking a name up, so the copy is the same in every configuration:
 *
 *  - every kind an annotation names (`x-telo-ref` and its `callsCoReferrers`,
 *    `x-telo-requires-zone`, a referrer rule's `referrer:`, a resource rule's
 *    `reachable.kind`, `x-telo-text-keys`) as the canonical `<module>.<Kind>`
 *    (`withCanonicalAnnotationKinds`);
 *  - every named-shape reference in its schema, contract and signature as the
 *    canonical id — a `telo://<Self|Alias>/<Type>` `$ref` rewritten to
 *    `telo:<module>/<Type>`, and a `!ref` in its contract or signature replaced
 *    by `{ $ref: "telo:<module>/<Type>" }`;
 *  - `extends` as `canonicalExtends` when one is given.
 *
 * A kind extending it in merge form inherits these nodes, and its own module is
 * the scope its effective schema is read in, so a name left for later would
 * name a kind or shape of the CHILD's module. The document the author wrote is
 * never written to: only the containers on the way to a rewritten node are
 * copied, and with nothing to rewrite the definition itself is returned. A name
 * the scope cannot answer is left as written, for the check that reports it.
 */
export function registeredDefinitionCopy<T extends object>(
  definition: T,
  aliases?: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
  canonicalExtends?: string,
): T {
  return registeredDefinitionForms(definition, aliases, aliasesByModule, canonicalExtends).registered;
}

/**
 * {@link registeredDefinitionCopy} with the step it is built from: `kinds` is
 * the definition with its annotation kinds canonical and every other node as
 * written — what a reader judging a kind document's annotations compares — and
 * `registered` adds the named-shape ids and `extends`.
 */
export function registeredDefinitionForms<T extends object>(
  definition: T,
  aliases?: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
  canonicalExtends?: string,
): { kinds: T; registered: T } {
  const metadata = (definition as { metadata?: { module?: string } }).metadata;
  const ownModule = metadata?.module;
  const resolver = moduleAliasScope(metadata, aliases, aliasesByModule);
  const resolveAuthority = (authority: string): string | undefined =>
    authority === "Self" ? ownModule : resolver?.moduleForAlias(authority);
  const kinds = resolver ? withCanonicalAnnotationKinds(definition, resolver) : definition;
  let copy: Record<string, unknown> | undefined = kinds === definition ? undefined : { ...(kinds as Record<string, unknown>) };
  for (const field of [...SCHEMA_FIELDS, ...SIGNATURE_FIELDS]) {
    const value = (kinds as Record<string, unknown>)[field];
    const canonical = canonicalTypeRefStrings(value, resolveAuthority, field !== "schema");
    if (canonical !== value) (copy ??= { ...(definition as Record<string, unknown>) })[field] = canonical;
  }
  if (canonicalExtends !== undefined && canonicalExtends !== (definition as { extends?: unknown }).extends) {
    (copy ??= { ...(definition as Record<string, unknown>) }).extends = canonicalExtends;
  }
  // The copies keep the place of the nodes they were built from.
  if (kinds !== definition) inheritSchemaPlaces(kinds, definition);
  if (copy) inheritSchemaPlaces(copy, definition);
  return { kinds, registered: (copy ?? definition) as T };
}

function canonicalTypeRefStrings(
  value: unknown,
  resolveAuthority: (authority: string) => string | undefined,
  /** Whether a `!ref` here names a shape — in a contract or a signature. */
  shapeRefs: boolean,
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (isTaggedSentinel(value)) {
    const target = shapeRefs ? refSentinelTarget(value) : undefined;
    if (!target || (target.indexes?.length ?? 0) > 0) return value;
    const module = resolveAuthority(target.alias ?? "Self");
    return module ? { $ref: canonicalTypeSchemaId(module, target.name) } : value;
  }
  if (Array.isArray(value)) {
    let items: unknown[] | undefined;
    value.forEach((item, index) => {
      const read = canonicalTypeRefStrings(item, resolveAuthority, shapeRefs);
      if (read !== item) (items ??= [...value])[index] = read;
    });
    return items ?? value;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  let copy: Record<string, unknown> | undefined;
  const ref = (value as { $ref?: unknown }).$ref;
  if (typeof ref === "string") {
    const { shape, pointer } = schemaReferenceParts(ref);
    const parsed = parseTeloTypeRef(shape);
    const module = parsed ? resolveAuthority(parsed.authority) : undefined;
    if (parsed && module) {
      copy = { ...value, $ref: `${canonicalTypeSchemaId(module, parsed.typeName)}${pointer === "#" ? "" : pointer}` };
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref") continue;
    const read = canonicalTypeRefStrings(child, resolveAuthority, shapeRefs);
    if (read !== child) (copy ??= { ...value })[key] = read;
  }
  return copy ?? value;
}

/** The slice of the definition registry that tells a named shape's kind. */
export interface ShapeKindSource {
  resolve(kind: string): ResourceDefinition | undefined;
}

/**
 * Stamps `$ref: "telo:<module>/<Type>"` beside every reference to a named shape,
 * the module being the one the WRITER's scope resolves it to. The reference stays
 * a reference; the id travels with it, so a reader holding it — a controller
 * reading another module's declaration included — resolves the shape its writer
 * meant rather than whichever shape of that name a registry happens to hold.
 */
function stampShapeReferences(
  value: unknown,
  resolveAuthority: (authority: string) => string | undefined,
  ownModule: string | undefined,
  namesShape: (kind: string) => boolean,
): void {
  if (value === null || typeof value !== "object") return;
  if (isTaggedSentinel(value) || (value as { __compiled?: unknown }).__compiled) return;
  if (Array.isArray(value)) {
    for (const item of value) stampShapeReferences(item, resolveAuthority, ownModule, namesShape);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  if (isResolvedReference(value)) {
    if ((Array.isArray(value.indexes) && value.indexes.length > 0) || !namesShape(value.kind)) return;
    // Stamped already, in its writer's scope: the id travels with the reference.
    if (parseCanonicalTypeSchemaId((value as { $ref?: unknown }).$ref)) return;
    const module = value.alias === undefined || value.alias === "Self" ? ownModule : resolveAuthority(value.alias);
    if (module) (value as unknown as Record<string, unknown>).$ref = canonicalTypeSchemaId(module, value.name);
    return;
  }
  for (const child of Object.values(value)) stampShapeReferences(child, resolveAuthority, ownModule, namesShape);
}

/**
 * A copy of a named shape's schema with every shape reference nested in it — a
 * resolved `!ref`, or the authored `telo://<Self|Alias>/<Type>` — made canonical
 * in the declaring module's scope, the form the registry holds a shape in, so
 * whatever validates through it follows the reference. A reference that resolves
 * to nothing stays as written, for the check that reports it; the schema passed
 * in is not changed.
 */
export function canonicalShapeSchema(
  schema: Record<string, any>,
  ownModule: string,
  moduleForAlias: (alias: string) => string | undefined,
): Record<string, any> {
  const copy = plainCopy(schema) as Record<string, any>;
  canonicalizeInPlace(
    copy,
    (authority) => (authority === "Self" ? ownModule : moduleForAlias(authority)),
    ownModule,
    false,
  );
  return copy;
}

function plainCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainCopy);
  if (value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) out[key] = plainCopy(child);
  return out;
}

export { authoredSchemaRef, carryAuthoredSchemaRef } from "./authored-schema-refs.js";

function canonicalizeInPlace(
  value: unknown,
  resolveAuthority: (authority: string) => string | undefined,
  ownModule: string | undefined,
  // The type field's OWN value is a declared reference slot (`x-telo-ref:
  // Telo.Type`), with its own reference validation and its own editor picker.
  // Only what sits INSIDE it is schema, and only schema is this pass's to
  // canonicalize — rewriting the slot itself would hand the reference checker
  // a shape it is right to reject.
  isSlotRoot: boolean,
): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) canonicalizeInPlace(item, resolveAuthority, ownModule, false);
    return;
  }
  const obj = value as Record<string, unknown>;
  // A JSON Pointer into a named shape keeps its pointer; the shape is named as a
  // whole shape is.
  const { shape, pointer } = typeof obj.$ref === "string" ? schemaReferenceParts(obj.$ref) : { shape: undefined, pointer: "#" };
  const parsed = parseTeloTypeRef(shape);
  if (parsed) {
    const module = resolveAuthority(parsed.authority);
    if (module) {
      recordAuthoredSchemaRef(obj, obj.$ref as string);
      obj.$ref = `${canonicalTypeSchemaId(module, parsed.typeName)}${pointer === "#" ? "" : pointer}`;
    }
  }
  // A reference the tag left behind. Rewritten in place rather than replaced,
  // so a node that carried siblings (a `title`, a `description`) keeps them —
  // a `$ref` beside other keywords is ordinary JSON Schema.
  const named = resolvedRefInSchema(obj);
  if (named) {
    const module = named.alias === undefined ? ownModule : resolveAuthority(named.alias);
    // An unresolvable alias is left exactly as written: `validateReferences`
    // is what reports a reference that names nothing, and guessing a module
    // here would turn a typo into a `$ref` that resolves to the wrong shape.
    if (module) {
      const canonical = canonicalTypeSchemaId(module, named.name);
      if (isSlotRoot) {
        // At the slot root the reference STAYS a reference — the canonical id
        // is stamped beside it. That is what makes the resolver alias-aware
        // here: it reads the module off the id instead of matching a bare
        // `metadata.name` across a flattened list, where two libraries
        // declaring a shape of the same name collide silently.
        obj.$ref = canonical;
      } else {
        delete obj[RESOLVED_REFERENCE_MARKER];
        delete obj.kind;
        delete obj.name;
        delete obj.alias;
        delete obj.indexes;
        obj.$ref = canonical;
      }
    }
  }
  for (const key of Object.keys(obj)) canonicalizeInPlace(obj[key], resolveAuthority, ownModule, false);
}

/**
 * A copy of a type field written inside a template body, with every `!ref` it
 * holds — at its root, inside `properties`, inside `$defs`, at any depth —
 * replaced by the canonical `{ $ref: "telo:<module>/<type>" }`.
 *
 * A body entry is still authoring data when the definition is read: the loader
 * resolves no `!ref` inside a `Telo.Definition`, and the pass above walks only a
 * manifest's own type fields. A reader resolving the contract of the call a body
 * makes gets the same canonical form a registered resource carries, so a named
 * shape there is resolved rather than read as a schema that constrains nothing.
 * `resolveModule` answers an alias in the declaring module's scope; an alias it
 * cannot answer is left as written.
 */
export function withCanonicalRefSentinels(
  value: unknown,
  ownModule: string | undefined,
  resolveModule: (alias: string) => string | undefined,
): unknown {
  const target = refSentinelTarget(value);
  if (target) {
    const module =
      target.alias === undefined || target.alias === "Self" ? ownModule : resolveModule(target.alias);
    return module ? { $ref: canonicalTypeSchemaId(module, target.name) } : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => withCanonicalRefSentinels(item, ownModule, resolveModule));
  }
  if (value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = withCanonicalRefSentinels(child, ownModule, resolveModule);
  }
  return out;
}

/**
 * A resolved `!ref` sitting where a schema belongs, or null.
 *
 * Recognised by the resolved-reference marker: Phase 2.5 writes
 * `{__ref, kind, name, alias?}` and nothing else, and a node carrying JSON Schema keywords is a schema that happens to be
 * beside one rather than a reference. Being conservative here is the safe
 * direction — a node this declines to rewrite stays a reference for
 * `validateReferences` to judge, while one it rewrote wrongly would silently
 * become a different shape.
 */
function resolvedRefInSchema(
  obj: Record<string, unknown>,
): { name: string; alias?: string } | null {
  if (!isResolvedReference(obj)) return null;
  // A family member names no shape.
  if (Array.isArray(obj.indexes) && obj.indexes.length > 0) return null;
  for (const key of Object.keys(obj)) {
    // `$ref` is allowed so the pass is idempotent at a slot root, where the id
    // is stamped BESIDE the reference rather than replacing it.
    if (
      key !== RESOLVED_REFERENCE_MARKER &&
      key !== "kind" &&
      key !== "name" &&
      key !== "alias" &&
      key !== "indexes" &&
      key !== "$ref"
    ) {
      return null;
    }
  }
  return typeof obj.alias === "string"
    ? { name: obj.name, alias: obj.alias }
    : { name: obj.name };
}

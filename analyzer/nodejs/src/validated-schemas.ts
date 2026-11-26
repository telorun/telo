/**
 * The schemas Telo validates values against, as declared: a kind's `schema:`,
 * `status:`, contracts and signature, a need type's `fields` (each its own
 * document) and `parameters`, the
 * signature a callable instance declares for itself, and each `variables:` /
 * `secrets:` entry of a module document — every document the in-place cycle
 * rule (`schema-in-place-cycle.ts`) is judged over.
 *
 * Browser-safe.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { instanceDeclaresSignature, isCallableKind } from "./callable-signature.js";
import type { DefResolver } from "./extends-resolution.js";
import { isModuleKind } from "./module-kinds.js";
import { needTypeOf } from "./need-type.js";
import { residualEntrySchema } from "./residual-schema.js";
import { isHoistedFragmentDefKey, NAME_MAP_KEYWORDS } from "./manifest-schemas.js";
import { inPlaceCycleThrough, lookupTarget, nodeAt, pointerSegments, writtenReferences, type InPlaceHop } from "./schema-in-place-cycle.js";

type Schema = Record<string, any>;

const isObject = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);

/** A schema a definition validates values against, and the field holding it. */
export interface SchemaDocument {
  readonly path: string;
  readonly schema: Schema;
}

/** An inline type field's schema: raw JSON Schema, or the `schema` of an inline
 *  `{ kind, schema }` declaration; a reference holds none. */
function typeFieldSchema(value: unknown, path: string): SchemaDocument | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.kind === "string") return isObject(value.schema) ? { path: `${path}.schema`, schema: value.schema } : undefined;
  if (typeof value.__ref === "string" || typeof value.name === "string") return undefined;
  return { path, schema: value };
}

/** The schemas of a signature's halves: each parameter's and the result's. */
function signatureDocuments(params: unknown, returns: unknown): SchemaDocument[] {
  const out: SchemaDocument[] = [];
  if (Array.isArray(params)) {
    params.forEach((param, i) => {
      if (isObject(param) && isObject(param.schema)) out.push({ path: `params[${i}].schema`, schema: param.schema });
    });
  }
  if (isObject(returns) && isObject(returns.schema)) out.push({ path: "returns.schema", schema: returns.schema });
  return out;
}

/** Every schema a kind's definition validates values against: its `schema:`,
 *  `status:`, contracts, signature, and a need type's fields and `parameters`. */
export function definitionSchemaDocuments(definition: ResourceDefinition | ResourceManifest): SchemaDocument[] {
  const doc = definition as unknown as Record<string, unknown>;
  const out: SchemaDocument[] = [];
  const needType = needTypeOf(definition as ResourceDefinition);
  // A need type's fields are each a document of their own, as the environment
  // read validates each; its synthesized `schema:` composes them.
  if (needType) {
    for (const [name, field] of Object.entries(needType.fields)) {
      if (isObject(field)) out.push({ path: `fields.${name}`, schema: field });
    }
  }
  for (const field of ["schema", "status"]) {
    const value = doc[field];
    if (isObject(value) && !(needType && field === "schema")) out.push({ path: field, schema: value });
  }
  for (const field of ["inputType", "outputType"]) {
    const found = typeFieldSchema(doc[field], field);
    if (found) out.push(found);
  }
  out.push(...signatureDocuments(doc.params, doc.returns));
  const parameters = needType?.parameters;
  if (isObject(parameters)) out.push({ path: "parameters", schema: parameters });
  return out;
}

/** The signature schemas a callable instance declares for itself. */
export function callableInstanceSchemaDocuments(manifest: ResourceManifest, resolve: DefResolver): SchemaDocument[] {
  const doc = manifest as unknown as Record<string, unknown>;
  if (doc.params === undefined && doc.returns === undefined) return [];
  const definition = resolve(String(manifest.kind), manifest as unknown as ResourceDefinition);
  if (!isCallableKind(definition, resolve)) return [];
  return signatureDocuments(
    instanceDeclaresSignature(definition, resolve, "params") ? doc.params : undefined,
    instanceDeclaresSignature(definition, resolve, "returns") ? doc.returns : undefined,
  );
}

/** The schema each `variables:` / `secrets:` entry of a module document holds
 *  its value to, keyed `variables.<name>` / `secrets.<name>`: each entry is a
 *  document of its own. */
export function moduleInputSchemaDocuments(moduleDoc: ResourceManifest): SchemaDocument[] {
  if (!isModuleKind(moduleDoc.kind)) return [];
  const out: SchemaDocument[] = [];
  for (const block of ["variables", "secrets"] as const) {
    const entries = (moduleDoc as unknown as Record<string, unknown>)[block];
    if (!isObject(entries)) continue;
    for (const [name, entry] of Object.entries(entries)) {
      if (isObject(entry)) out.push({ path: `${block}.${name}`, schema: residualEntrySchema(entry) });
    }
  }
  return out;
}

/** A schema document's first in-place cycle, and the field holding it. */
export interface DocumentCycle {
  readonly path: string;
  readonly cycle: InPlaceHop[];
}

/**
 * The in-place cycles `documents` close through their own local references
 * alone, each document keyed by its field path — what a declaration nothing
 * else references can recurse through.
 */
export function localInPlaceCycles(
  documents: readonly SchemaDocument[] | ResourceDefinition | ResourceManifest,
): DocumentCycle[] {
  const list = Array.isArray(documents) ? documents : definitionSchemaDocuments(documents as ResourceManifest);
  const out: DocumentCycle[] = [];
  for (const { path, schema } of list) {
    const cycle = inPlaceCycleThrough(path, {
      documentOf: (document) => (document === path ? schema : undefined),
      targetOf: (ref, document) => lookupTarget(ref, document, () => false),
    });
    if (cycle) out.push({ path, cycle });
  }
  return out;
}

/**
 * The first in-place cycle through a named shape's own schema, registered as
 * `id`, every other named document read through `lookup` — what the kernel
 * refuses when it registers the shape.
 */
export function shapeInPlaceCycle(id: string, schema: Schema, lookup: (id: string) => unknown): InPlaceHop[] | undefined {
  const documentOf = (document: string): unknown => (document === id ? schema : lookup(document));
  return inPlaceCycleThrough(id, {
    documentOf,
    targetOf: (ref, document) => lookupTarget(ref, document, (target) => documentOf(target) !== undefined),
  });
}

/** A `#` reference a schema document writes that names no node of it. */
export interface DanglingLocalReference {
  /** The field holding the document. */
  readonly path: string;
  /** The keys of the node writing the reference, from the document's root. */
  readonly keys: readonly (string | number)[];
  readonly ref: string;
}

/**
 * Every `#` / `#/…` reference of `documents` naming no node of the document it
 * is written in — what a validator compiling the document alone cannot
 * resolve. A reference beneath a nested `$id` or an annotation is read against
 * another base and is not judged, nor is a reserved fragment pointer, which
 * fragment expansion places.
 */
export function danglingLocalReferences(documents: readonly SchemaDocument[]): DanglingLocalReference[] {
  const out: DanglingLocalReference[] = [];
  for (const { path, schema } of documents) {
    for (const { at, ref } of writtenReferences(schema)) {
      if (ref !== "#" && !ref.startsWith("#/")) continue;
      const target = pointerSegments(ref);
      if (target[0] === "$defs" && target[1] !== undefined && isHoistedFragmentDefKey(target[1])) continue;
      const keys = keysAlong(schema, pointerSegments(at));
      if (keys && nodeAt(schema, ref) === undefined) out.push({ path, keys, ref });
    }
  }
  return out;
}

/** `segments` as keys, a list index a number; undefined where the way passes a
 *  nested `$id` or an annotation. */
function keysAlong(document: unknown, segments: readonly string[]): (string | number)[] | undefined {
  const keys: (string | number)[] = [];
  let node = document;
  for (const segment of segments) {
    if (Array.isArray(node)) {
      keys.push(Number(segment));
      node = node[Number(segment)];
      continue;
    }
    const named = NAME_MAP_KEYWORDS.has(String(keys[keys.length - 1]));
    if (!named && segment.startsWith("x-")) return undefined;
    node = isObject(node) ? node[segment] : undefined;
    keys.push(segment);
    if (isObject(node) && typeof node.$id === "string") return undefined;
  }
  return keys;
}

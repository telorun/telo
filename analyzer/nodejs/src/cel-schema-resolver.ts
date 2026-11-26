import type { CelEnvironment, SchemaTypeResolver } from "@telorun/cel";
import { celTypeOfValueType, valueTypeOf } from "@telorun/sdk";
import { isDeclaredDocument } from "./referenced-shape.js";
import { manifestFragmentRef, withSchemaFragments, X_TELO_FRAGMENT } from "./manifest-schemas.js";
import { REFERENCE_KEYS } from "./schema-compat.js";
import { resolveSchemaReference, type NamedShapeLookup } from "./schema-reference.js";

type Schema = Record<string, any>;

/** Keywords that say nothing about a node's type. */
const ANNOTATION_KEYS: ReadonlySet<string> = new Set(["title", "description", "$comment", "examples", "default"]);

/**
 * The one resolver every binding the analyzer hands the CEL engine is read
 * through, to full depth:
 *
 * - a value type (`x-telo-type`) is its CEL type, by name — one of CEL's own
 *   (`bytes`, a timestamp) or one `env` registers;
 * - a reference leaving its document (`telo:<Module>/<Type>`) is the named
 *   shape `shapes` answers, made canonical by `canonical`, keywords written
 *   beside it kept;
 * - a node recorded as a document of its own ({@link isDeclaredDocument}) is
 *   read as its own root, so a `#/…` reference inside it resolves there;
 * - a shared fragment's local reference read beneath a node cut from the root
 *   it was hoisted to is that fragment, read as a document of its own.
 *
 * A reference leaving its document that `shapes` cannot answer is left to the
 * engine, which reads it as `dyn` and lists it unresolved: a reference finding
 * reports it at its place (`schema-unjudged.ts` holds every such reference to
 * one), or it is an internal error.
 *
 * Every other node, `#/…` references included, is the engine's to read.
 */
export function celSchemaResolver(
  env: CelEnvironment,
  shapes: NamedShapeLookup | undefined,
  canonical?: (id: string, schema: Schema) => Schema,
): SchemaTypeResolver {
  const answered = new Map<string, Schema | undefined>();
  const lookup: NamedShapeLookup = (id) => {
    if (answered.has(id)) return answered.get(id);
    const shape = shapes?.(id);
    const read = shape && canonical ? canonical(id, shape) : shape;
    answered.set(id, read);
    return read;
  };
  // A node handed back inside a node built here keeps the document it was
  // written in.
  const rootOf = new WeakMap<object, Schema>();
  const resolver: SchemaTypeResolver = ({ node, root }) => {
    const schema = node as Schema;
    const entry = valueTypeOf(schema);
    if (entry) return { name: celTypeOfValueType(entry) };
    const ref = schema.$ref;
    if (typeof ref === "string" && !ref.startsWith("#")) {
      const target = resolveSchemaReference(ref, root as Schema | undefined, lookup);
      if (!target) return undefined;
      const beside = Object.entries(schema).filter(
        ([key]) => !REFERENCE_KEYS.has(key) && !ANNOTATION_KEYS.has(key) && !key.startsWith("x-"),
      );
      if (beside.length === 0) return { document: { node: target.node, root: target.document } };
      rootOf.set(target.node, target.document);
      const allOf = Array.isArray(schema.allOf) ? [...schema.allOf, target.node] : [target.node];
      return { document: { node: { ...Object.fromEntries(beside), allOf } } };
    }
    const fragment = cutFragmentReference(schema, root as Schema | undefined);
    if (fragment) return { document: { node: fragment, root: fragment } };
    const written = rootOf.get(schema);
    if (written !== undefined && written !== root) return { document: { node: schema, root: written } };
    if (root !== undefined && schema !== root && isDeclaredDocument(schema)) {
      return { document: { node: schema, root: schema } };
    }
    return undefined;
  };
  return resolver;
}

/** Each shared fragment as a document of its own, its recursive parts hoisted
 *  to its root. */
const fragmentDocuments = new Map<string, Schema>();

/** The fragment a `#/$defs/…` reference stamped `x-telo-fragment` names, where
 *  the root it is read in does not hold that definition. */
function cutFragmentReference(node: Schema, root: Schema | undefined): Schema | undefined {
  const ref = node.$ref;
  const name = node[X_TELO_FRAGMENT];
  if (typeof ref !== "string" || typeof name !== "string" || !ref.startsWith("#/$defs/")) return undefined;
  const key = decodeURIComponent(ref.slice("#/$defs/".length)).replace(/~1/g, "/").replace(/~0/g, "~");
  if (root?.$defs && typeof root.$defs === "object" && key in root.$defs) return undefined;
  let document = fragmentDocuments.get(name);
  if (!document) {
    document = withSchemaFragments({ $ref: manifestFragmentRef(name) } as Schema);
    fragmentDocuments.set(name, document);
  }
  return document;
}

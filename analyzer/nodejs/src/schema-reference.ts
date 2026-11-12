/**
 * **What a schema `$ref` names, and the document that node lives in** — the one
 * reader every schema walk crosses a reference through.
 *
 * A reference is one of three things, all read here:
 *
 *  - a document-local JSON Pointer (`#`, `#/$defs/Row`, `#/$defs/Row/properties/id`),
 *    resolved against the document holding it;
 *  - a named shape (`telo:<Module>/<Type>`, or the authored `telo://<Alias>/<Type>`
 *    a lookup may answer), whose schema is a document of its own;
 *  - a JSON Pointer INTO a named shape (`telo:<Module>/<Type>#/properties/action`),
 *    resolved against that shape's document.
 *
 * Whatever is reached, a local pointer written beneath it resolves against the
 * TARGET's document, never the referrer's — which is what lets a member reached
 * by a pointer keep every annotation it declares, as a whole shape does.
 *
 * Browser-safe: no Node built-ins.
 */
import { resolveSchemaPointer } from "./manifest-navigation.js";

type Schema = Record<string, any>;

/**
 * Resolves a named shape — a `$ref`'s part before any `#`, in its canonical
 * `telo:<Module>/<Type>` spelling — to the shape's schema, its own document.
 * The one lookup every eval-site walk takes: the analyzer and the kernel each
 * hand it their shared registry's `schemaForId`, so the sites `telo check` reads
 * and the sites the kernel expands are one set.
 */
export type NamedShapeLookup = (id: string) => Schema | undefined;

/** What a reference names: the node, the document its own references resolve
 *  against, and — when the reference crossed into a named shape — that shape's
 *  id. */
export interface SchemaReferenceTarget {
  readonly node: Schema;
  readonly document: Schema;
  readonly shape?: string;
}

/** A reference split at its fragment: the named shape it crosses into (none for
 *  a document-local pointer) and the pointer, `#`-prefixed. */
export interface SchemaReferenceParts {
  readonly shape?: string;
  readonly pointer: string;
}

const isSchema = (value: unknown): value is Schema =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function schemaReferenceParts(ref: string): SchemaReferenceParts {
  const hash = ref.indexOf("#");
  if (hash === 0) return { pointer: ref };
  if (hash < 0) return { shape: ref, pointer: "#" };
  return { shape: ref.slice(0, hash), pointer: ref.slice(hash) };
}

/** True when the reference names a node below a document's root — a local
 *  pointer other than `#`, or a pointer into a named shape. */
export function isPointerReference(ref: string): boolean {
  const { pointer } = schemaReferenceParts(ref);
  return pointer.replace(/^#\/?/, "") !== "";
}

/**
 * The node `ref` names, written in `document`, and the document it lives in —
 * or undefined when it names nothing this can resolve: a local pointer with no
 * known document, a shape the lookup does not answer, a pointer naming no
 * schema object.
 */
export function resolveSchemaReference(
  ref: string,
  document: Schema | undefined,
  lookup: NamedShapeLookup | undefined,
): SchemaReferenceTarget | undefined {
  const { shape, pointer } = schemaReferenceParts(ref);
  if (shape === undefined) {
    if (!document) return undefined;
    const node = resolveSchemaPointer(document, pointer);
    return isSchema(node) ? { node, document } : undefined;
  }
  const root = lookup?.(shape);
  if (!isSchema(root)) return undefined;
  const node = resolveSchemaPointer(root, pointer);
  return isSchema(node) ? { node, document: root, shape } : undefined;
}

/** `node` with every `$ref` it IS followed, through {@link resolveSchemaReference},
 *  and the document the last one lives in. A cycle stops where it closes. */
export function followSchemaReferences(
  node: Schema,
  document: Schema | undefined,
  lookup: NamedShapeLookup | undefined,
): { node: Schema; document: Schema | undefined } {
  const seen = new Set<object>();
  let at = { node, document };
  while (typeof at.node.$ref === "string" && !seen.has(at.node)) {
    seen.add(at.node);
    const next = resolveSchemaReference(at.node.$ref, at.document, lookup);
    if (!next) break;
    at = { node: next.node, document: next.document };
  }
  return at;
}

import { parseCanonicalTypeSchemaId, RuntimeError, type ResourceManifest } from "@telorun/sdk";

/** The reach of the module that wrote a schema: the declarations a `telo:`
 *  reference in it can name. */
export interface ShapeReferenceScope {
  declarationInModule(moduleName: string, name: string): ResourceManifest | undefined;
}

/** One schema of a contract or a signature, with where it is written. */
export interface ShapeReferenceSite {
  /** The field as an author reads it (`returns.schema`, `inputType`). */
  readonly path: string;
  readonly schema: unknown;
  /** The module that wrote the schema — the instance's own, or the one declaring
   *  the definition it is inherited from. */
  readonly writer: ShapeReferenceScope;
}

/** Schemas found clean, per writer: a reference is judged in the reach of the
 *  module that wrote it, so a verdict holds for that module alone. */
const judged = new WeakMap<ShapeReferenceScope, WeakSet<object>>();

/**
 * The kernel twin of the analyzer's `REFERENCE_KIND_MISMATCH` at a contract or
 * signature `!ref`: a reference that names a declaration holding no named shape
 * — an invocable, a provider — constrains nothing, so it is refused where the
 * kernel resolves the shape. A schema is walked once per writing module however
 * many resources hold it.
 */
export function refuseNonShapeReferences(
  label: string,
  sites: readonly ShapeReferenceSite[],
  shapeOf: (id: string) => unknown,
): void {
  for (const site of sites) {
    let clean = judged.get(site.writer);
    if (!clean) judged.set(site.writer, (clean = new WeakSet()));
    const found = nonShapeReference(site.schema, shapeOf, site.writer, clean);
    if (!found) continue;
    throw new RuntimeError(
      "ERR_REFERENCE_KIND_MISMATCH",
      `${label}: '${site.path}' names '${found.name}', a ${String(found.declaration.kind)}, ` +
        `which is not a named shape, so it constrains nothing. Reference a \`Telo.JsonSchema\` or another ` +
        `named shape, or write the schema inline.`,
    );
  }
}

function nonShapeReference(
  schema: unknown,
  shapeOf: (id: string) => unknown,
  writer: ShapeReferenceScope,
  clean: WeakSet<object>,
): { name: string; declaration: ResourceManifest } | undefined {
  if (schema === null || typeof schema !== "object" || clean.has(schema)) return undefined;
  if (Array.isArray(schema)) {
    for (const item of schema) {
      const found = nonShapeReference(item, shapeOf, writer, clean);
      if (found) return found;
    }
    return undefined;
  }
  const node = schema as Record<string, unknown>;
  const named = parseCanonicalTypeSchemaId(node.$ref);
  if (named && shapeOf(node.$ref as string) === undefined) {
    const declaration = writer.declarationInModule(named.moduleName, named.typeName);
    if (declaration) return { name: named.typeName, declaration };
  }
  for (const value of Object.values(node)) {
    const found = nonShapeReference(value, shapeOf, writer, clean);
    if (found) return found;
  }
  clean.add(schema);
  return undefined;
}

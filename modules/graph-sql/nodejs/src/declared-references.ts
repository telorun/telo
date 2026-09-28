import { getRefIdentity, type ResourceContext, type ResourceManifest } from "@telorun/sdk";
import { refuse } from "./declared-table.js";

/**
 * The store's schema rules read what its references NAME, one level deep — the
 * same reading `telo check` takes through a rule's `resolve:`, so the two halves
 * compare the same thing: which declarations the schema lists and which
 * connection it names, compared by declared name.
 *
 * Declarations rather than instances because an engine `Schema` publishes
 * neither its tables nor its connection; what it lists is only in its manifest.
 */

interface DeclaredRef {
  readonly name: string;
  readonly alias?: string;
}

/** A reference as a declaration holds it: the `{ kind, name, alias? }` the
 *  loader wrote, or — once injection has reached that declaration — the live
 *  instance, which carries the same identity. */
function asRef(value: unknown): DeclaredRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const injected = getRefIdentity(value);
  if (injected) return { name: injected.name };
  const ref = value as { name?: unknown; alias?: unknown };
  if (typeof ref.name !== "string") return undefined;
  return { name: ref.name, alias: typeof ref.alias === "string" ? ref.alias : undefined };
}

function refList(value: unknown): DeclaredRef[] {
  return Array.isArray(value)
    ? value.map(asRef).filter((ref): ref is DeclaredRef => ref !== undefined)
    : [];
}

class Declarations {
  constructor(
    private readonly ctx: ResourceContext,
    private readonly describe: string,
  ) {}

  of(ref: DeclaredRef, field: string): ResourceManifest {
    const lookup = this.ctx.resolveDeclaredManifest;
    if (!lookup) {
      throw new Error(
        `${this.describe}: this runtime cannot read declarations, so the store cannot check ` +
          `that its tables belong to its schema. Upgrade the runtime.`,
      );
    }
    const declared = lookup.call(this.ctx, ref.name, ref.alias);
    if (!declared) {
      throw new Error(
        `${this.describe}: '${field}' names '${ref.alias ? `${ref.alias}.` : ""}${ref.name}', ` +
          `which resolves to no declared resource.`,
      );
    }
    return declared;
  }
}

/** `GRAPH_TABLE_NOT_IN_SCHEMA` and `GRAPH_SCHEMA_CONNECTION_MISMATCH`. */
export function assertSchemaHoldsTables(
  ctx: ResourceContext,
  storeName: string,
  describe: string,
): void {
  const declarations = new Declarations(ctx, describe);
  const store = declarations.of({ name: storeName }, "metadata.name") as Record<string, unknown>;
  const schemaRef = asRef(store.schema);
  if (!schemaRef) throw new Error(`${describe}: 'schema' is not a reference.`);
  const schema = declarations.of(schemaRef, "schema") as Record<string, unknown>;
  const listed = new Set(refList(schema.tables).map((ref) => ref.name));

  for (const field of ["nodes", "relationships"] as const) {
    refList(store[field]).forEach((typeRef, index) => {
      const type = declarations.of(typeRef, `${field}[${index}]`) as Record<string, unknown>;
      const table = asRef(type.table);
      if (!table || !listed.has(table.name)) {
        refuse(
          "GRAPH_TABLE_NOT_IN_SCHEMA",
          `${describe} lists '${typeRef.name}' at '${field}[${index}]', whose table ` +
            `'${table?.name ?? "(inline)"}' schema '${schemaRef.name}' does not list in ` +
            `'tables:'. The schema is what creates and migrates the table; add it there.`,
        );
      }
    });
  }

  const own = asRef(store.connection)?.name;
  const schemas = asRef(schema.connection)?.name;
  if (own === undefined || own !== schemas) {
    refuse(
      "GRAPH_SCHEMA_CONNECTION_MISMATCH",
      `${describe} runs on connection '${own ?? "(inline)"}', but schema '${schemaRef.name}' ` +
        `lives on '${schemas ?? "(inline)"}'. The schema must create its tables where the ` +
        `graph reads them.`,
    );
  }
}

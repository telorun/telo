import { getRefIdentity, type ResourceContext, type ResourceManifest } from "@telorun/sdk";
import { refuse } from "./declared-table.js";

/**
 * The rules of the layered kinds read what a reference NAMES, one level deep —
 * the reading `telo check` takes through a rule's `resolve:` — so their creation
 * twins read the same declarations: the table as its author wrote it (the
 * strategy table kind's own fields, before its `base:` adds the bookkeeping),
 * and which tables a schema lists.
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

type Fields = Record<string, unknown>;

class Declarations {
  constructor(
    private readonly ctx: ResourceContext,
    private readonly describe: string,
  ) {}

  of(ref: DeclaredRef, field: string): ResourceManifest {
    const lookup = this.ctx.resolveDeclaredManifest;
    if (!lookup) {
      throw new Error(
        `${this.describe}: this runtime cannot read declarations, so the structural rules of a ` +
          `layered graph cannot be checked. Upgrade the runtime.`,
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

function fieldsOf(value: unknown): Fields {
  return value && typeof value === "object" ? (value as Fields) : {};
}

/** The table a type's `table:` names, as its author declared it. */
export interface AuthoredTable {
  readonly name: string;
  readonly fields: Fields;
  readonly columns: Readonly<Record<string, Fields>>;
  readonly indexes: Readonly<Record<string, Fields>>;
}

export function authoredTable(
  ctx: ResourceContext,
  typeName: string,
  describe: string,
): AuthoredTable {
  const declarations = new Declarations(ctx, describe);
  const type = declarations.of({ name: typeName }, "metadata.name") as Fields;
  const ref = asRef(type.table);
  if (!ref) throw new Error(`${describe}: 'table' is not a reference.`);
  const fields = declarations.of(ref, "table") as Fields;
  const entries = (value: unknown) =>
    Object.fromEntries(Object.entries(fieldsOf(value)).map(([key, entry]) => [key, fieldsOf(entry)]));
  return { name: ref.name, fields, columns: entries(fields.columns), indexes: entries(fields.indexes) };
}

/** `GRAPH_TABLE_UNIQUE_DECLARED` — `exempt` is the node key, which its own rule covers. */
export function assertNothingUnique(describe: string, table: AuthoredTable, exempt?: string): void {
  for (const [name, column] of Object.entries(table.columns)) {
    if (name !== exempt && (column.primaryKey === true || column.unique === true)) {
      refuse(
        "GRAPH_TABLE_UNIQUE_DECLARED",
        `${describe}: table '${table.name}' declares column '${name}' as a primary key or ` +
          `unique. A layered table holds one row per layer for the same key, so a value unique ` +
          `across the table would refuse the second layer's row.`,
      );
    }
  }
  for (const [name, index] of Object.entries(table.indexes)) {
    if (index.unique === true) {
      refuse(
        "GRAPH_TABLE_UNIQUE_DECLARED",
        `${describe}: table '${table.name}' declares unique index '${name}'. A layered table ` +
          `holds one row per layer for the same key, so a value unique across the table would ` +
          `refuse the second layer's row.`,
      );
    }
  }
}

/** `GRAPH_TABLE_NOT_IN_SCHEMA` and `GRAPH_SCHEMA_CONNECTION_MISMATCH`. */
export function assertSchemaHoldsTables(
  ctx: ResourceContext,
  storeName: string,
  describe: string,
  bookkeeping: readonly string[] = [],
): void {
  const declarations = new Declarations(ctx, describe);
  const store = declarations.of({ name: storeName }, "metadata.name") as Fields;
  const schemaRef = asRef(store.schema);
  if (!schemaRef) throw new Error(`${describe}: 'schema' is not a reference.`);
  const schema = declarations.of(schemaRef, "schema") as Fields;
  const listed = new Set(refList(schema.tables).map((ref) => ref.name));

  for (const field of ["nodes", "relationships"] as const) {
    refList(store[field]).forEach((typeRef, index) => {
      const type = declarations.of(typeRef, `${field}[${index}]`) as Fields;
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

  for (const field of bookkeeping) {
    const table = asRef(store[field]);
    if (!table || !listed.has(table.name)) {
      refuse(
        "GRAPH_TABLE_NOT_IN_SCHEMA",
        `${describe} names table '${table?.name ?? "(inline)"}' at '${field}', which schema ` +
          `'${schemaRef.name}' does not list in 'tables:'. The schema is what creates and ` +
          `migrates the table; add it there.`,
      );
    }
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

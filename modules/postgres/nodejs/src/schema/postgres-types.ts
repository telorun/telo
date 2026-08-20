/**
 * PostgreSQL's type vocabulary, declared as data.
 *
 * Types are structured, never spelled into a scalar — `type: varchar` with
 * `length: 64`, not `varchar(64)` — so nothing has to parse a type back apart
 * and the parameter is an editable field rather than a substring.
 *
 * `udt` is what PostgreSQL calls the type when reading it back, which is what
 * makes a declared type and a live one comparable without parsing either.
 */
export interface PostgresTypeEntry {
  readonly udt: string;
  /** Whether `length` applies (`varchar(64)`). */
  readonly lengthed?: boolean;
  /** Whether `precision` / `scale` apply (`numeric(12,2)`). */
  readonly precise?: boolean;
  /** How the type is spelled in DDL, when that differs from its declared name. */
  readonly ddl?: string;
}

export const POSTGRES_TYPES: Readonly<Record<string, PostgresTypeEntry>> = {
  text: { udt: "text" },
  varchar: { udt: "varchar", lengthed: true, ddl: "varchar" },
  char: { udt: "bpchar", lengthed: true, ddl: "char" },
  citext: { udt: "citext" },
  uuid: { udt: "uuid" },
  json: { udt: "json" },
  jsonb: { udt: "jsonb" },
  boolean: { udt: "bool" },
  smallint: { udt: "int2" },
  integer: { udt: "int4" },
  bigint: { udt: "int8" },
  numeric: { udt: "numeric", precise: true },
  real: { udt: "float4" },
  doublePrecision: { udt: "float8", ddl: "double precision" },
  date: { udt: "date" },
  time: { udt: "time" },
  timestamp: { udt: "timestamp" },
  timestamptz: { udt: "timestamptz" },
  interval: { udt: "interval" },
  bytea: { udt: "bytea" },
  inet: { udt: "inet" },
  cidr: { udt: "cidr" },
  macaddr: { udt: "macaddr" },
  tsvector: { udt: "tsvector" },
};

export type PostgresTypeName = keyof typeof POSTGRES_TYPES;

export function typeEntry(name: string): PostgresTypeEntry {
  const entry = POSTGRES_TYPES[name];
  if (!entry) {
    throw new Error(
      `Postgres.Table: unknown column type '${name}'. Known types: ` +
        `${Object.keys(POSTGRES_TYPES).sort().join(", ")}.`,
    );
  }
  return entry;
}

/**
 * Widening is safe, narrowing is not. Only the engine knows which is which,
 * which is why this lives here rather than in the shared reconciler: a
 * `length: 255` → `length: 64` narrowing is nameable precisely because the
 * declared type is concrete.
 */
const WIDENS: Readonly<Record<string, readonly string[]>> = {
  int2: ["int4", "int8", "numeric", "float4", "float8"],
  int4: ["int8", "numeric", "float8"],
  int8: ["numeric"],
  float4: ["float8"],
  varchar: ["text", "varchar"],
  bpchar: ["varchar", "text"],
  citext: ["text"],
  date: ["timestamp", "timestamptz"],
  timestamp: ["timestamptz"],
  json: ["jsonb"],
};

export function widens(from: string, to: string): boolean {
  return from === to || (WIDENS[from]?.includes(to) ?? false);
}

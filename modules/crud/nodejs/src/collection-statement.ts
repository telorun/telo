import type { SqlDialect } from "@telorun/sql";
import type { CollectionQuery, Filter } from "./collection-query.js";
import { KEY, type ModelProperty } from "./model-properties.js";

export interface Statement {
  sql: string;
  params: unknown[];
}

const COMPARE = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;

// Not the backslash: how a backslash reads inside a string literal is an engine setting.
const LIKE_ESCAPE = "!";

/** Text as a LIKE pattern that matches it literally, anywhere. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[!%_]/g, (wildcard) => LIKE_ESCAPE + wildcard)}%`;
}

/**
 * Renders the statements of one request. Every identifier is a declared
 * property's column, quoted by the dialect; every value is a bound parameter.
 */
class Rendering {
  readonly params: unknown[] = [];

  constructor(private readonly dialect: SqlDialect) {}

  readonly bind = (value: unknown): string => {
    this.params.push(value);
    return this.dialect.placeholderStyle === "numbered" ? `$${this.params.length}` : "?";
  };

  column(property: ModelProperty | string): string {
    return this.dialect.quoteIdentifier(typeof property === "string" ? property : property.column);
  }

  filter(filter: Filter): string {
    const column = this.column(filter.property);
    if (filter.operator === "in") return this.dialect.renderIn(column, filter.values, this.bind);
    if (filter.operator === "contains") {
      // Folded on both sides: LIKE alone is case-sensitive on some engines.
      return `LOWER(${column}) LIKE LOWER(${this.bind(containsPattern(String(filter.values[0])))}) ESCAPE '${LIKE_ESCAPE}'`;
    }
    return `${column} ${COMPARE[filter.operator]} ${this.bind(filter.values[0])}`;
  }

  /** Rows strictly after the cursor's, in the order {@link order} gives. */
  after(query: CollectionQuery): string | undefined {
    if (!query.after) return undefined;
    const id = this.column(KEY);
    const past = query.sort.descending ? "<" : ">";
    if (query.sort.property.name === KEY) return `${id} ${past} ${this.bind(query.after.id)}`;
    const column = this.column(query.sort.property);
    if (query.after.value === null) return `(${column} IS NULL AND ${id} > ${this.bind(query.after.id)})`;
    return (
      `(${column} ${past} ${this.bind(query.after.value)}` +
      ` OR (${column} = ${this.bind(query.after.value)} AND ${id} > ${this.bind(query.after.id)})` +
      ` OR ${column} IS NULL)`
    );
  }

  /** Nulls last in either direction, `id` ascending between equal values. */
  order(query: CollectionQuery): string {
    const direction = query.sort.descending ? "DESC" : "ASC";
    const id = this.column(KEY);
    if (query.sort.property.name === KEY) return `${id} ${direction}`;
    const column = this.column(query.sort.property);
    return `(${column} IS NULL) ASC, ${column} ${direction}, ${id} ASC`;
  }

  where(conditions: (string | undefined)[]): string {
    const present = conditions.filter((condition): condition is string => condition !== undefined);
    return present.length > 0 ? ` WHERE ${present.join(" AND ")}` : "";
  }
}

/**
 * One page, read one row past `limit` so the caller can tell whether another
 * follows. Columns come back under their property names.
 */
export function pageStatement(
  dialect: SqlDialect,
  table: string,
  properties: Iterable<ModelProperty>,
  query: CollectionQuery,
): Statement {
  const rendering = new Rendering(dialect);
  const columns = [...properties]
    .map((property) => `${rendering.column(property)} AS ${rendering.column(property.name)}`)
    .join(", ");
  const where = rendering.where([...query.filters.map((filter) => rendering.filter(filter)), rendering.after(query)]);
  const sql = `SELECT ${columns} FROM ${table}${where} ORDER BY ${rendering.order(query)} LIMIT ${rendering.bind(query.limit + 1)}`;
  return { sql, params: rendering.params };
}

/** How many rows the filters match, whatever the page. */
export function countStatement(dialect: SqlDialect, table: string, query: CollectionQuery): Statement {
  const rendering = new Rendering(dialect);
  const where = rendering.where(query.filters.map((filter) => rendering.filter(filter)));
  return { sql: `SELECT COUNT(*) AS ${rendering.column("total")} FROM ${table}${where}`, params: rendering.params };
}

/** The written row, under its property names, in the shape `returning` gives. */
function returningClause(rendering: Rendering, returning: Iterable<ModelProperty>): string {
  const columns = [...returning].map((property) => `${rendering.column(property)} AS ${rendering.column(property.name)}`);
  return ` RETURNING ${columns.join(", ")}`;
}

/**
 * Inserts `record`: the columns are the properties the shape declares and the
 * record holds, never a key the record merely carries.
 */
export function insertStatement(
  dialect: SqlDialect,
  table: string,
  properties: Iterable<ModelProperty>,
  record: Record<string, unknown>,
  returning: Iterable<ModelProperty>,
): Statement {
  const rendering = new Rendering(dialect);
  const written = [...properties].filter((property) => record[property.name] !== undefined);
  const values =
    written.length > 0
      ? ` (${written.map((property) => rendering.column(property)).join(", ")}) VALUES (${written
          .map((property) => rendering.bind(record[property.name]))
          .join(", ")})`
      : " DEFAULT VALUES";
  return { sql: `INSERT INTO ${table}${values}${returningClause(rendering, returning)}`, params: rendering.params };
}

/**
 * Replaces the row `id` names with `record`: every column the shape declares is
 * set, to the record's value or to NULL where it holds none, and no other
 * column is touched. A shape declaring no column leaves the row as it is and
 * still reports whether it exists.
 */
export function replaceStatement(
  dialect: SqlDialect,
  table: string,
  properties: Iterable<ModelProperty>,
  id: unknown,
  record: Record<string, unknown>,
  returning: Iterable<ModelProperty>,
): Statement {
  const rendering = new Rendering(dialect);
  const key = rendering.column(KEY);
  const assignments = [...properties]
    .filter((property) => property.name !== KEY)
    .map((property) => `${rendering.column(property)} = ${rendering.bind(record[property.name] ?? null)}`);
  const set = assignments.length > 0 ? assignments.join(", ") : `${key} = ${key}`;
  const sql = `UPDATE ${table} SET ${set} WHERE ${key} = ${rendering.bind(id)}${returningClause(rendering, returning)}`;
  return { sql, params: rendering.params };
}

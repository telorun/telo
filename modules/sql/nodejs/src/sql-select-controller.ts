import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { SqlConnectionResource } from "./sql-connection-controller.js";
import { resolveSqlConnection } from "./sql-connection-ref.js";
import type { SqlResult } from "./sql-query-controller.js";
import type { SqlTransactionResource } from "./sql-transaction-controller.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type ColumnDef = string | { column: string; as?: string } | { expr: string; as?: string };

type Op =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "like"
  | "ilike"
  | "in"
  | "is_null"
  | "is_not_null";

interface Condition {
  when?: boolean;
  column: string;
  op: Op;
  value?: unknown;
  ref?: string;
}

interface RawClause {
  when?: boolean;
  sql: string;
  bindings?: unknown[];
}

interface OrGroup {
  when?: boolean;
  or: WhereNode[];
}

interface AndGroup {
  when?: boolean;
  and: WhereNode[];
}

interface NotGroup {
  when?: boolean;
  not: WhereNode;
}

type WhereNode = Condition | RawClause | OrGroup | AndGroup | NotGroup;

interface OrderByItem {
  column: string;
  direction?: "asc" | "desc";
}

interface SelectManifest {
  metadata: { name: string; module: string };
  connection?: SqlConnectionResource;
  transaction?: SqlTransactionResource;
  from: string;
  columns?: ColumnDef[];
  distinct?: boolean;
  distinctOn?: string[];
  where?: WhereNode[];
  groupBy?: string[];
  having?: WhereNode[];
  orderBy?: OrderByItem[];
  limit?: unknown;
  offset?: unknown;
  inputSchema?: Record<string, { type?: string; default?: unknown }>;
}

// ── Controller ────────────────────────────────────────────────────────────────

class SqlSelectResource implements ResourceInstance {
  constructor(
    private readonly manifest: SelectManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(input: unknown): Promise<SqlResult> {
    const m = this.manifest;
    const ctx = this.ctx;
    const inputs = {
      ...extractDefaults(m.inputSchema),
      ...((input as Record<string, unknown>) ?? {}),
    };
    const expandCtx = { inputs };

    const where = ctx.expandValue(m.where ?? [], expandCtx) as WhereNode[];
    const having = ctx.expandValue(m.having ?? [], expandCtx) as WhereNode[];
    const limit = m.limit != null ? ctx.expandValue(m.limit, expandCtx) : undefined;
    const offset = m.offset != null ? ctx.expandValue(m.offset, expandCtx) : undefined;

    const connection = resolveSqlConnection(m.connection, ctx) ?? m.transaction?.getConnection();
    if (!connection) {
      throw new Error("Sql.Select: either 'connection' or 'transaction' must be set");
    }

    const { sql, params } = buildSelect(m, where, having, limit, offset, connection.driver);
    const result = await connection.execute<Record<string, unknown>>(sql, params, m.transaction);
    return { rows: result.rows, rowCount: result.rows.length };
  }
}

// ── SQL building ──────────────────────────────────────────────────────────────

type Driver = "postgres" | "sqlite";

function buildSelect(
  m: SelectManifest,
  where: WhereNode[],
  having: WhereNode[],
  limit: unknown,
  offset: unknown,
  driver: Driver,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const addParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const parts: string[] = [];

  // SELECT [DISTINCT [ON (...)]]
  let selectClause = "SELECT";
  if (m.distinct) {
    selectClause += " DISTINCT";
  } else if (m.distinctOn && m.distinctOn.length > 0) {
    selectClause += ` DISTINCT ON (${m.distinctOn.map(quoteIdent).join(", ")})`;
  }
  const colList = m.columns && m.columns.length > 0 ? buildColumns(m.columns) : "*";
  parts.push(`${selectClause} ${colList}`);

  // FROM
  parts.push(`FROM ${quoteIdent(m.from)}`);

  // WHERE
  const whereStr = buildClauses(where, "AND", driver, addParam);
  if (whereStr) parts.push(`WHERE ${whereStr}`);

  // GROUP BY
  if (m.groupBy && m.groupBy.length > 0) {
    parts.push(`GROUP BY ${m.groupBy.map(quoteIdent).join(", ")}`);
  }

  // HAVING
  const havingStr = buildClauses(having, "AND", driver, addParam);
  if (havingStr) parts.push(`HAVING ${havingStr}`);

  // ORDER BY
  if (m.orderBy && m.orderBy.length > 0) {
    const orderParts = m.orderBy.map(
      (o) => `${quoteIdent(o.column)} ${(o.direction ?? "asc").toUpperCase()}`,
    );
    parts.push(`ORDER BY ${orderParts.join(", ")}`);
  }

  // LIMIT / OFFSET
  if (limit != null) parts.push(`LIMIT ${addParam(limit)}`);
  if (offset != null) parts.push(`OFFSET ${addParam(offset)}`);

  return { sql: parts.join("\n"), params };
}

function buildColumns(columns: ColumnDef[]): string {
  return columns
    .map((c) => {
      if (typeof c === "string") return quoteIdent(c);
      if ("expr" in c) return c.as ? `${c.expr} AS ${quoteIdent(c.as)}` : c.expr;
      return c.as ? `${quoteIdent(c.column)} AS ${quoteIdent(c.as)}` : quoteIdent(c.column);
    })
    .join(", ");
}

function buildClauses(
  clauses: WhereNode[],
  join: "AND" | "OR",
  driver: Driver,
  addParam: (v: unknown) => string,
): string | null {
  const parts: string[] = [];
  for (const clause of clauses) {
    if (clause.when === false) continue;
    const built = buildClause(clause, driver, addParam);
    if (built !== null) parts.push(built);
  }
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return parts.join(` ${join} `);
}

function buildClause(
  node: WhereNode,
  driver: Driver,
  addParam: (v: unknown) => string,
): string | null {
  if ("not" in node) {
    const inner = buildClause(node.not, driver, addParam);
    return inner ? `NOT (${inner})` : null;
  }
  if ("or" in node) {
    const inner = buildClauses(node.or, "OR", driver, addParam);
    return inner ? `(${inner})` : null;
  }
  if ("and" in node) {
    const inner = buildClauses(node.and, "AND", driver, addParam);
    return inner ? `(${inner})` : null;
  }
  if ("sql" in node) {
    return renumberFragment(node.sql, node.bindings ?? [], addParam);
  }
  if ("column" in node) {
    return buildCondition(node, driver, addParam);
  }
  return null;
}

function buildCondition(c: Condition, driver: Driver, addParam: (v: unknown) => string): string {
  const col = quoteIdent(c.column);
  switch (c.op) {
    case "is_null":
      return `${col} IS NULL`;
    case "is_not_null":
      return `${col} IS NOT NULL`;
    case "in": {
      if (driver === "postgres") {
        return `${col} = ANY(${addParam(c.value)})`;
      }
      const placeholders = (c.value as unknown[]).map((v) => addParam(v)).join(", ");
      return `${col} IN (${placeholders})`;
    }
    default: {
      const rhs = c.ref !== undefined ? quoteIdent(c.ref) : addParam(c.value);
      return `${col} ${opToSql(c.op)} ${rhs}`;
    }
  }
}

function renumberFragment(
  sql: string,
  bindings: unknown[],
  addParam: (v: unknown) => string,
): string {
  return sql.replace(/\$(\d+)/g, (_, idx) => addParam(bindings[Number(idx) - 1]));
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function opToSql(op: Op): string {
  const map: Record<string, string> = {
    eq: "=",
    ne: "<>",
    lt: "<",
    lte: "<=",
    gt: ">",
    gte: ">=",
    like: "LIKE",
    ilike: "ILIKE",
  };
  const sql = map[op];
  if (!sql) throw new Error(`Sql.Select: unknown operator '${op}'`);
  return sql;
}

// ── Exports ───────────────────────────────────────────────────────────────────

function extractDefaults(inputSchema?: Record<string, { default?: unknown }>): Record<string, unknown> {
  if (!inputSchema) return {};
  const defaults: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(inputSchema)) {
    if ("default" in def) defaults[key] = def.default;
  }
  return defaults;
}

export function register(): void {}

export async function create(
  resource: SelectManifest,
  ctx: ResourceContext,
): Promise<SqlSelectResource> {
  return new SqlSelectResource(resource, ctx);
}

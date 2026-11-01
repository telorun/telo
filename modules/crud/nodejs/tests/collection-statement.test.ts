import { describe, expect, it } from "vitest";
import type { SqlDialect } from "@telorun/sql";
import { planFacet, planQuery } from "../src/collection-query.js";
import {
  countStatement,
  facetStatement,
  insertStatement,
  pageStatement,
  replaceStatement,
} from "../src/collection-statement.js";
import { modelProperties } from "../src/model-properties.js";
import { encodeCursor, encodeFacetCursor } from "../src/page-cursor.js";

const quote = (name: string) => `"${name}"`;

/** One placeholder per element, as SQLite binds a list. */
const qmark: SqlDialect = {
  placeholderStyle: "qmark",
  quoteIdentifier: quote,
  renderIn: (column, values, bind) => `${column} IN (${values.map(bind).join(", ")})`,
  renderCurrentTimeMillis: () => "0",
};

/** The whole list on one placeholder, as PostgreSQL binds it. */
const numbered: SqlDialect = {
  placeholderStyle: "numbered",
  quoteIdentifier: quote,
  renderIn: (column, values, bind) => `${column} = ANY(${bind(values)})`,
  renderCurrentTimeMillis: () => "0",
};

const properties = modelProperties({
  properties: {
    id: { type: "integer" },
    text: { type: "string" },
    isDone: { type: "boolean" },
    dueOn: { type: "string", format: "date" },
    status: { enum: ["open", "done"] },
  },
});

const accepted = {
  filters: [
    { property: "text", operator: "contains" },
    { property: "status", operator: "in" },
    { property: "isDone", operator: "eq" },
  ],
  sort: [{ property: "dueOn" }],
};

const query = planQuery(properties, accepted, {
  filters: [
    { property: "text", operator: "contains", value: "50%_!" },
    { property: "status", operator: "in", value: ["open", "done"] },
    { property: "isDone", value: "true" },
  ],
  sort: [{ property: "dueOn", direction: "desc" }],
  limit: 10,
  cursor: encodeCursor({ sort: "-dueOn", value: "2026-10-07", id: 4 }),
});

const filters =
  `LOWER("text") LIKE LOWER(?) ESCAPE '!' AND "status" IN (?, ?) AND "is_done" = ?`;

describe("the statements of one list request", () => {
  it("names only declared columns and binds every value, one placeholder each", () => {
    expect(pageStatement(qmark, "tasks", properties.values(), query)).toEqual({
      sql:
        `SELECT "id" AS "id", "text" AS "text", "is_done" AS "isDone", "due_on" AS "dueOn", "status" AS "status"` +
        ` FROM tasks WHERE ${filters}` +
        ` AND ("due_on" < ? OR ("due_on" = ? AND "id" > ?) OR "due_on" IS NULL)` +
        ` ORDER BY ("due_on" IS NULL) ASC, "due_on" DESC, "id" ASC LIMIT ?`,
      params: ["%50!%!_!!%", "open", "done", true, "2026-10-07", "2026-10-07", 4, 11],
    });
  });

  it("numbers its placeholders and renders membership as the dialect does", () => {
    expect(pageStatement(numbered, "tasks", properties.values(), query)).toEqual({
      sql:
        `SELECT "id" AS "id", "text" AS "text", "is_done" AS "isDone", "due_on" AS "dueOn", "status" AS "status"` +
        ` FROM tasks WHERE LOWER("text") LIKE LOWER($1) ESCAPE '!' AND "status" = ANY($2) AND "is_done" = $3` +
        ` AND ("due_on" < $4 OR ("due_on" = $5 AND "id" > $6) OR "due_on" IS NULL)` +
        ` ORDER BY ("due_on" IS NULL) ASC, "due_on" DESC, "id" ASC LIMIT $7`,
      params: ["%50!%!_!!%", ["open", "done"], true, "2026-10-07", "2026-10-07", 4, 11],
    });
  });

  it("counts the filtered set, not the page", () => {
    expect(countStatement(qmark, "tasks", query)).toEqual({
      sql: `SELECT COUNT(*) AS "total" FROM tasks WHERE ${filters}`,
      params: ["%50!%!_!!%", "open", "done", true],
    });
  });

  it("continues among the rows with no value once the cursor is past the last one that has one", () => {
    const amongNulls = planQuery(properties, accepted, {
      sort: [{ property: "dueOn" }],
      cursor: encodeCursor({ sort: "dueOn", value: null, id: 9 }),
    });
    expect(pageStatement(qmark, "tasks", properties.values(), amongNulls).sql).toContain(
      `WHERE ("due_on" IS NULL AND "id" > ?) ORDER BY ("due_on" IS NULL) ASC, "due_on" ASC, "id" ASC`,
    );
  });
});

describe("an absent filter", () => {
  const optional = { ...accepted, filters: [{ property: "dueOn", operator: "absent" }] };
  const where = (value: string) =>
    countStatement(qmark, "tasks", planQuery(properties, optional, { filters: [{ property: "dueOn", operator: "absent", value }] }));

  it("selects the rows holding no value, binding nothing", () => {
    expect(where("true")).toEqual({ sql: `SELECT COUNT(*) AS "total" FROM tasks WHERE "due_on" IS NULL`, params: [] });
  });

  it("selects the rows holding one when false", () => {
    expect(where("false").sql).toBe(`SELECT COUNT(*) AS "total" FROM tasks WHERE "due_on" IS NOT NULL`);
  });
});

describe("the statement of one facet page", () => {
  const faceted = { ...accepted, facets: [{ property: "status" }] };

  it("counts each present value under the filters, in value order, one past the page", () => {
    const facet = planFacet(properties, faceted, {
      facet: "status",
      filters: [{ property: "text", operator: "contains", value: "plan" }],
      limit: 5,
    });
    expect(facetStatement(qmark, "tasks", facet)).toEqual({
      sql:
        `SELECT "status" AS "value", COUNT(*) AS "count" FROM tasks` +
        ` WHERE LOWER("text") LIKE LOWER(?) ESCAPE '!' AND "status" IS NOT NULL` +
        ` GROUP BY "status" ORDER BY "status" ASC LIMIT ?`,
      params: ["%plan%", 6],
    });
  });

  it("continues after the cursor's value, numbering placeholders where the dialect does", () => {
    const facet = planFacet(properties, faceted, {
      facet: "status",
      cursor: encodeFacetCursor({ property: "status", value: "done" }),
    });
    expect(facetStatement(numbered, "tasks", facet)).toEqual({
      sql:
        `SELECT "status" AS "value", COUNT(*) AS "count" FROM tasks WHERE "status" IS NOT NULL AND "status" > $1` +
        ` GROUP BY "status" ORDER BY "status" ASC LIMIT $2`,
      params: ["done", 26],
    });
  });
});

/** What a write names: the record's properties, without its key. */
const writable = modelProperties({
  properties: {
    text: { type: "string" },
    isDone: { type: "boolean" },
    dueOn: { type: "string", format: "date" },
  },
});

const stored = `RETURNING "id" AS "id", "text" AS "text", "is_done" AS "isDone", "due_on" AS "dueOn", "status" AS "status"`;

describe("the statement that replaces a row", () => {
  const record = { text: "Plan", isDone: false, status: "done", unknown: "x" };

  it("sets every column its shape declares, NULL where the record holds no value, and no other", () => {
    expect(replaceStatement(qmark, "tasks", writable.values(), 7, record, properties.values())).toEqual({
      sql: `UPDATE tasks SET "text" = ?, "is_done" = ?, "due_on" = ? WHERE "id" = ? ${stored}`,
      params: ["Plan", false, null, 7],
    });
  });

  it("numbers its placeholders where the dialect does", () => {
    expect(replaceStatement(numbered, "tasks", writable.values(), 7, record, properties.values()).sql).toBe(
      `UPDATE tasks SET "text" = $1, "is_done" = $2, "due_on" = $3 WHERE "id" = $4 ${stored}`,
    );
  });

  it("is a whole statement over a shape declaring no column", () => {
    expect(replaceStatement(qmark, "tasks", modelProperties({}).values(), 7, {}, properties.values())).toEqual({
      sql: `UPDATE tasks SET "id" = "id" WHERE "id" = ? ${stored}`,
      params: [7],
    });
  });
});

describe("the statement that creates a row", () => {
  it("names the declared columns the record holds, never a key it merely carries", () => {
    const record = { text: "Plan", isDone: false, "text) VALUES ('x'); --": "x" };
    expect(insertStatement(qmark, "tasks", writable.values(), record, properties.values())).toEqual({
      sql: `INSERT INTO tasks ("text", "is_done") VALUES (?, ?) ${stored}`,
      params: ["Plan", false],
    });
  });

  it("leaves every column to the table where the record holds none", () => {
    expect(insertStatement(numbered, "tasks", writable.values(), {}, properties.values())).toEqual({
      sql: `INSERT INTO tasks DEFAULT VALUES ${stored}`,
      params: [],
    });
  });
});

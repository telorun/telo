import type { ResourceContext } from "@telorun/sdk";
import type { DeclaredTable } from "@telorun/sql";
import { describe, expect, it } from "vitest";
import { SqlNodeType } from "../src/node-type.js";
import { SqlRelationshipType } from "../src/relationship-type.js";
import { encodeKeyTail } from "@telorun/graph";
import { create } from "../src/sql-graph-store.js";

const column = (name: string, rest: Record<string, unknown> = {}) => ({
  name,
  type: "text",
  params: {},
  nullable: false,
  array: false,
  primaryKey: false,
  unique: false,
  ...rest,
});

const table = (name: string, columns: ReturnType<typeof column>[]): DeclaredTable =>
  ({ name, columns, internalColumns: [], indexes: [], foreignKeys: [], checks: [] }) as DeclaredTable;

/** A store over a connection that records every statement it is handed. */
async function storeOver(statements: unknown[]) {
  const person = new SqlNodeType("id", {
    declaration: table("people", [column("id", { primaryKey: true })]),
  });
  const knows = new SqlRelationshipType(person, person, "source", "target", {
    declaration: table("knows", [column("source"), column("target")]),
  });
  const connection = {
    dialect: { quoteIdentifier: (name: string) => `"${name}"` },
    execute: async () => ({ rows: [] }),
    executeTemplate: async (...statement: unknown[]) => {
      statements.push(statement);
      return { rows: [] };
    },
  };
  const schema = { qualifiedTableName: (declared: DeclaredTable) => `"${declared.name}"` };
  const declarations: Record<string, unknown> = {
    kb: {
      connection: { name: "db" },
      schema: { name: "appSchema" },
      nodes: [{ name: "person" }],
      relationships: [{ name: "knows" }],
    },
    appSchema: { connection: { name: "db" }, tables: [{ name: "people" }, { name: "knowsTable" }] },
    person: { table: { name: "people" } },
    knows: { table: { name: "knowsTable" } },
  };
  const ctx = {
    resolveRef: (value: unknown) => value,
    resolveDeclaredManifest: (name: string) => declarations[name],
  } as unknown as ResourceContext;
  const store = await create(
    {
      metadata: { name: "kb" },
      connection,
      schema,
      nodes: [person],
      relationships: [knows],
    },
    ctx,
  );
  return { store, person, knows };
}

describe("a tail the store did not write", () => {
  const notATail = '[["x","p00042"]]';

  it("is cursorInvalid on findNodes, with no statement issued", async () => {
    const statements: unknown[] = [];
    const { store, person } = await storeOver(statements);
    expect(await store.findNodes(person, {}, { limit: 10, after: notATail })).toEqual({
      status: "cursorInvalid",
    });
    expect(statements).toEqual([]);
  });

  it("is cursorInvalid on findRelationships, with no statement issued", async () => {
    const statements: unknown[] = [];
    const { store, knows } = await storeOver(statements);
    expect(await store.findRelationships(knows, {}, {}, { limit: 10, after: notATail })).toEqual({
      status: "cursorInvalid",
    });
    expect(statements).toEqual([]);
  });

  it("is cursorInvalid on traverse, with no statement issued", async () => {
    const statements: unknown[] = [];
    const { store, person, knows } = await storeOver(statements);
    const prepared = store.prepareTraversal({
      from: person,
      to: person,
      hops: [{ relationship: knows, direction: "out", minHops: 1, maxHops: 1 }],
    });
    expect(await store.traverse(prepared, "p00001", {}, { limit: 10, after: notATail })).toEqual({
      status: "cursorInvalid",
    });
    expect(statements).toEqual([]);
  });
});

describe("a tail the store can read", () => {
  const hostile = "p' OR 1=1; DROP TABLE people; --";
  type Subject = Awaited<ReturnType<typeof storeOver>>;

  /** The text and the bound values of the one statement a call issues. */
  async function issued(call: (subject: Subject) => Promise<unknown>) {
    const statements: unknown[][] = [];
    await call(await storeOver(statements));
    expect(statements).toHaveLength(1);
    const [fragments, values] = statements[0];
    return { text: JSON.stringify(fragments), values: values as unknown[] };
  }

  const listings: Record<string, (key: string) => (subject: Subject) => Promise<unknown>> = {
    findNodes:
      (key) =>
      ({ store, person }) =>
        store.findNodes(person, {}, { limit: 10, after: encodeKeyTail([key]) }),
    findRelationships:
      (key) =>
      ({ store, knows }) =>
        store.findRelationships(knows, {}, {}, { limit: 10, after: encodeKeyTail([key, key]) }),
    traverse:
      (key) =>
      ({ store, person, knows }) =>
        store.traverse(
          store.prepareTraversal({
            from: person,
            to: person,
            hops: [{ relationship: knows, direction: "out", minHops: 1, maxHops: 1 }],
          }),
          "p00001",
          {},
          { limit: 10, after: encodeKeyTail([key]) },
        ),
  };

  for (const [method, listing] of Object.entries(listings)) {
    it(`reaches ${method}'s statement only as a bound value`, async () => {
      const benign = await issued(listing("p00042"));
      const attack = await issued(listing(hostile));
      expect(attack.text).toBe(benign.text);
      expect(attack.text).not.toContain("DROP");
      expect(attack.values).toContain(hostile);
    });
  }
});

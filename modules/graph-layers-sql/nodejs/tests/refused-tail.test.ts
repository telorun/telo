import type { ResourceContext } from "@telorun/sdk";
import type { DeclaredTable, SqlConnection, SqlSchema } from "@telorun/sql";
import { describe, expect, it } from "vitest";
import { CurrentLayerStore } from "../src/current-store.js";
import { LayeredNodeType } from "../src/node-type.js";
import { encodeKeyTail } from "@telorun/graph";
import { LayeredRelationshipType } from "../src/relationship-type.js";

const column = (name: string) => ({
  name,
  type: "text",
  params: {},
  nullable: false,
  array: false,
  primaryKey: false,
  unique: false,
});

const table = (name: string, columns: string[]): DeclaredTable =>
  ({
    name,
    columns: [...columns, "graph_layer", "graph_effect"].map(column),
    internalColumns: ["graph_layer", "graph_effect"],
    indexes: [],
    foreignKeys: [],
    checks: [],
  }) as DeclaredTable;

/** A two-layer stack over a connection that records every statement it is handed. */
function storeOver(statements: unknown[]) {
  const person = new LayeredNodeType("id", { declaration: table("people", ["id"]) });
  const knows = new LayeredRelationshipType(person, person, "source", "target", {
    declaration: table("knows", ["source", "target"]),
  });
  const connection = {
    dialect: { quoteIdentifier: (name: string) => `"${name}"` },
    executeTemplate: async (...statement: unknown[]) => {
      statements.push(statement);
      return { rows: [] };
    },
  } as unknown as SqlConnection;
  const schema = {
    qualifiedTableName: (declared: DeclaredTable) => `"${declared.name}"`,
  } as unknown as SqlSchema;
  const ctx = {} as ResourceContext;
  const layer = (name: string, bases: CurrentLayerStore[]) =>
    new CurrentLayerStore(`store "${name}"`, ctx, connection, schema, name, bases, [person], [knows]);
  return { store: layer("top", [layer("base", [])]), person, knows };
}

type Subject = ReturnType<typeof storeOver>;

const listings: Record<string, (after: string) => (subject: Subject) => Promise<unknown>> = {
  findNodes:
    (after) =>
    ({ store, person }) =>
      store.findNodes(person, {}, { limit: 10, after }),
  findRelationships:
    (after) =>
    ({ store, knows }) =>
      store.findRelationships(knows, {}, {}, { limit: 10, after }),
  traverse:
    (after) =>
    ({ store, person, knows }) =>
      store.traverse(
        store.prepareTraversal({
          from: person,
          to: person,
          hops: [{ relationship: knows, direction: "out", minHops: 1, maxHops: 1 }],
        }),
        "p00001",
        {},
        { limit: 10, after },
      ),
};

const arity: Record<string, number> = { findNodes: 1, findRelationships: 2, traverse: 1 };

describe("a tail the layered store did not write", () => {
  for (const [method, listing] of Object.entries(listings)) {
    it(`is cursorInvalid on ${method}, with no statement issued`, async () => {
      const statements: unknown[] = [];
      expect(await listing('[["x","p00042"]]')(storeOver(statements))).toEqual({
        status: "cursorInvalid",
      });
      expect(statements).toEqual([]);
    });
  }
});

describe("a tail the layered store can read", () => {
  const hostile = "p' OR 1=1; DROP TABLE people; --";

  /** The text and the bound values of the one statement a call issues. */
  async function issued(call: (subject: Subject) => Promise<unknown>) {
    const statements: unknown[][] = [];
    await call(storeOver(statements));
    expect(statements).toHaveLength(1);
    const [fragments, values] = statements[0];
    return { text: JSON.stringify(fragments), values: values as unknown[] };
  }

  for (const [method, listing] of Object.entries(listings)) {
    it(`reaches ${method}'s statement only as a bound value`, async () => {
      const tail = (key: string) => encodeKeyTail(Array(arity[method]).fill(key));
      const benign = await issued(listing(tail("p00042")));
      const attack = await issued(listing(tail(hostile)));
      expect(attack.text).toBe(benign.text);
      expect(attack.text).not.toContain("DROP");
      expect(attack.values).toContain(hostile);
    });
  }

  it("binds every layer name, so none reaches statement text", async () => {
    const { text, values } = await issued(listings.findNodes(encodeKeyTail(["p00042"])));
    expect(text).not.toContain("top");
    expect(text).not.toContain("base");
    expect(values).toEqual(expect.arrayContaining(["top", "base"]));
  });
});

import {
  createCancellationSource,
  type InvokeContext,
  type ResourceContext,
  type ZoneEntry,
} from "@telorun/sdk";
import type { DeclaredTable, SqlConnection, SqlInstantSchema } from "@telorun/sql";
import { describe, expect, it } from "vitest";
import { DraftedLayerStore } from "../src/drafted-store.js";
import { LayeredNodeType } from "../src/node-type.js";
import { encodeKeyTail } from "@telorun/graph";
import { encodeSelectedTail } from "../src/page-tail.js";
import { LayeredRelationshipType } from "../src/relationship-type.js";

const INTERNAL = [
  "graph_layer",
  "graph_state",
  "graph_effect",
  "graph_revision",
  "graph_over",
  "graph_written_at",
  "graph_resolution",
  "graph_resolved_by_type",
  "graph_resolved_by_id",
];

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
    columns: [...columns, ...INTERNAL].map(column),
    internalColumns: INTERNAL,
    indexes: [],
    foreignKeys: [],
    checks: [],
  }) as DeclaredTable;

const bookkeeping = (name: string, columns: string[]) => ({
  table: `"${name}"`,
  ...Object.fromEntries(columns.map((c) => [c, `"${c}"`])),
});

const DRAFT = "gdr_AAAAAAAAAAAAAAAAAAAAAA";
const session: ZoneEntry = { kind: "GraphLayers.DraftSession" } as ZoneEntry;
const inSession = { zones: [session] } as unknown as InvokeContext;

/**
 * A two-layer drafted stack over a connection that records every statement and
 * answers the bookkeeping reads a listing makes first: the layer ids, and the
 * open draft a session stands on.
 */
async function storeOver(statements: unknown[][], parent = "7", bookkeepingReads: unknown[][] = []) {
  const person = new LayeredNodeType("id", { declaration: table("people", ["id"]) });
  const knows = new LayeredRelationshipType(person, person, "source", "target", {
    declaration: table("knows", ["source", "target"]),
  });
  const connection = {
    dialect: { quoteIdentifier: (name: string) => `"${name}"` },
    hasOpenTransaction: () => false,
    executeTemplate: async (...statement: unknown[]) => {
      const text = (statement[0] as string[]).join("?");
      if (text.includes('FROM "graph_layers"') || text.includes('FROM "graph_drafts"')) {
        bookkeepingReads.push(statement);
      }
      if (text.includes('FROM "graph_layers"')) {
        return { rows: [{ id: "id-top", name: "top" }, { id: "id-base", name: "base" }] };
      }
      if (text.includes('FROM "graph_drafts"')) {
        return {
          rows: [
            {
              id: "draft-1",
              public_id: DRAFT,
              layer_id: "id-top",
              parent_revision: parent,
              created_at: "2026-10-09T00:00:00.000Z",
              published_at: null,
              discarded_at: null,
              revision: null,
            },
          ],
        };
      }
      statements.push(statement);
      return { rows: [] };
    },
  } as unknown as SqlConnection;
  const schema = {
    qualifiedTableName: (declared: DeclaredTable) => `"${declared.name}"`,
    currentInstant: () => "CURRENT_INSTANT",
  } as unknown as SqlInstantSchema;
  const store = (name: string, bases: DraftedLayerStore[]) => {
    const ctx = {
      zonesFor: (instance: unknown, context?: InvokeContext) => context?.zones ?? [],
    } as unknown as ResourceContext;
    return new DraftedLayerStore(
      `store "${name}"`,
      ctx,
      { type: "Store", id: name },
      connection,
      schema,
      name,
      bases,
      [person],
      [knows],
      bookkeeping("graph_layers", ["id", "name", "head_revision", "created_at", "created_by_type", "created_by_id"]) as never,
      bookkeeping("graph_drafts", [
        "id", "public_id", "layer_id", "parent_revision", "message", "created_at",
        "created_by_type", "created_by_id", "published_at", "published_by_type",
        "published_by_id", "discarded_at", "discarded_by_type", "discarded_by_id", "revision",
      ]) as never,
    );
  };
  const top = store("top", [store("base", [])]);
  await top.openSession(session, DRAFT, createCancellationSource());
  return { store: top, person, knows };
}

type Subject = Awaited<ReturnType<typeof storeOver>>;
type Listing = (after: string, ctx?: InvokeContext) => (subject: Subject) => Promise<unknown>;

const listings: Record<string, Listing> = {
  findNodes:
    (after, ctx) =>
    ({ store, person }) =>
      store.findNodes(person, {}, { limit: 10, after }, ctx),
  findRelationships:
    (after, ctx) =>
    ({ store, knows }) =>
      store.findRelationships(knows, {}, {}, { limit: 10, after }, ctx),
  traverse:
    (after, ctx) =>
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
        ctx,
      ),
  nodeConflicts:
    (after, ctx) =>
    ({ store, person }) =>
      store.nodeConflicts(person, { limit: 10, after }, ctx ?? inSession),
  relationshipConflicts:
    (after, ctx) =>
    ({ store, knows }) =>
      store.relationshipConflicts(knows, { limit: 10, after }, ctx ?? inSession),
};

const arity: Record<string, number> = {
  findNodes: 1,
  findRelationships: 2,
  traverse: 1,
  nodeConflicts: 1,
  relationshipConflicts: 2,
};
const sessionOnly = new Set(["nodeConflicts", "relationshipConflicts"]);
const keys = (method: string, key: string) => Array(arity[method]).fill(key);
const here = { draft: DRAFT, parent: "7" };

describe("a tail the drafted store does not follow", () => {
  for (const [method, listing] of Object.entries(listings)) {
    const refused = async (after: string, ctx?: InvokeContext, parent?: string) => {
      const statements: unknown[][] = [];
      const bookkeepingReads: unknown[][] = [];
      expect(
        await listing(after, ctx)(await storeOver(statements, parent, bookkeepingReads)),
      ).toEqual({ status: "cursorInvalid" });
      // No statement over the graph's tables is issued, and the reads of the
      // store's own bookkeeping that precede the check name nothing of the tail.
      expect(statements).toEqual([]);
      expect(JSON.stringify(bookkeepingReads)).not.toContain("p00042");
    };

    it(`is cursorInvalid on ${method} when it is not one this store wrote`, async () => {
      await refused('{"k":[["x","p00042"]]}', sessionOnly.has(method) ? inSession : undefined);
      await refused(encodeKeyTail(keys(method, "p00042")), sessionOnly.has(method) ? inSession : undefined);
    });

    it(`is cursorInvalid on ${method} when it was read from another draft`, async () => {
      await refused(
        encodeSelectedTail(keys(method, "p00042"), { draft: "gdr_BBBBBBBBBBBBBBBBBBBBBB", parent: "7" }),
        inSession,
      );
    });

    it(`is cursorInvalid on ${method} when the draft was rebased since`, async () => {
      await refused(encodeSelectedTail(keys(method, "p00042"), here), inSession, "8");
    });

    if (!sessionOnly.has(method)) {
      it(`is cursorInvalid on ${method} across the session boundary, either way`, async () => {
        await refused(encodeSelectedTail(keys(method, "p00042"), here), undefined);
        await refused(encodeSelectedTail(keys(method, "p00042")), inSession);
      });
    }
  }
});

describe("a tail the drafted store follows", () => {
  const hostile = "p' OR 1=1; DROP TABLE people; --";

  async function issued(call: (subject: Subject) => Promise<unknown>) {
    const statements: unknown[][] = [];
    await call(await storeOver(statements));
    expect(statements).toHaveLength(1);
    const [fragments, values] = statements[0];
    return { text: JSON.stringify(fragments), values: values as unknown[] };
  }

  for (const [method, listing] of Object.entries(listings)) {
    it(`reaches ${method}'s statement only as a bound value, inside a session`, async () => {
      const tail = (key: string) => encodeSelectedTail(keys(method, key), here);
      const benign = await issued(listing(tail("p00042"), inSession));
      const attack = await issued(listing(tail(hostile), inSession));
      expect(attack.text).toBe(benign.text);
      expect(attack.text).not.toContain("DROP");
      expect(attack.values).toContain(hostile);
      // The selector is re-checked in code and never reaches the engine.
      expect(attack.text).not.toContain(DRAFT);
      expect(attack.values).not.toContain(DRAFT);
    });
  }

  it("binds every layer id, so none reaches statement text", async () => {
    const { text, values } = await issued(
      listings.findNodes(encodeSelectedTail(["p00042"]), undefined),
    );
    expect(text).not.toContain("id-top");
    expect(text).not.toContain("id-base");
    expect(values).toEqual(expect.arrayContaining(["id-top", "id-base"]));
  });
});

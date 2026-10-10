import {
  createCancellationSource,
  type InvokeContext,
  type ResourceContext,
  type ZoneEntry,
} from "@telorun/sdk";
import type { DeclaredTable, SqlConnection, SqlInstantSchema } from "@telorun/sql";
import { describe, expect, it } from "vitest";
import { LayeredNodeType } from "../src/node-type.js";
import {
  baseListDigest,
  encodePinnedTail,
  encodeSelectedTail,
} from "../src/page-tail.js";
import { encodeKeyTail } from "@telorun/graph";
import { LayeredRelationshipType } from "../src/relationship-type.js";
import { RevisionedLayerStore } from "../src/revisioned-store.js";

const INTERNAL = [
  "graph_row",
  "graph_layer",
  "graph_changeset",
  "graph_from_revision",
  "graph_to_revision",
  "graph_effect",
  "graph_over",
  "graph_beneath",
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

/** What `top` is pinned to in these tests: `base` at its third revision. */
const PINNED = [{ layer: "base", revision: 3n }];
const NO_BASES = baseListDigest([]);

/**
 * A revisioned layer at head revision 7 over a connection that records every
 * statement and answers the bookkeeping reads a listing makes first: the
 * layer's id and head, the open draft a session stands on, and — when
 * `stacked` — a base list pinning `base` at revision 3, which is built on none.
 */
async function storeOver(
  statements: unknown[][],
  parent = "7",
  bookkeepingReads: unknown[][] = [],
  stacked = false,
) {
  const person = new LayeredNodeType("id", { declaration: table("people", ["id"]) });
  const knows = new LayeredRelationshipType(person, person, "source", "target", {
    declaration: table("knows", ["source", "target"]),
  });
  const connection = {
    dialect: { quoteIdentifier: (name: string) => `"${name}"` },
    hasOpenTransaction: () => false,
    executeTemplate: async (...statement: unknown[]) => {
      const text = (statement[0] as string[]).join("?");
      const ofBase = (statement[1] as unknown[]).includes("id-base");
      if (text.includes('FROM "graph_layers"')) {
        bookkeepingReads.push(statement);
        return {
          rows: [
            ofBase
              ? { id: "id-base", name: "base", head_revision: "3" }
              : { id: "id-top", name: "top", head_revision: "7" },
          ],
        };
      }
      if (text.includes('FROM "graph_changeset_bases"')) {
        bookkeepingReads.push(statement);
        return { rows: [{ base_layer_id: "id-base", base_revision: "3" }] };
      }
      if (text.includes('FROM "graph_changesets"')) {
        bookkeepingReads.push(statement);
        if (ofBase) return { rows: [{ bases_changeset: null }] };
        return {
          rows: [
            {
              id: "changeset-1",
              public_id: DRAFT,
              layer_id: "id-top",
              parent_revision: parent,
              created_at: "2026-10-09T00:00:00.000Z",
              published_at: null,
              discarded_at: null,
              revision: null,
              bases_changeset: stacked ? "changeset-0" : null,
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
  const ctx = {
    zonesFor: (instance: unknown, context?: InvokeContext) => context?.zones ?? [],
  } as unknown as ResourceContext;
  const changesetColumns = [
    "id", "public_id", "layer_id", "parent_revision", "message", "created_at",
    "created_by_type", "created_by_id", "published_at", "published_by_type",
    "published_by_id", "discarded_at", "discarded_by_type", "discarded_by_id", "revision",
    "label", "labelled_at", "labelled_by_type", "labelled_by_id", "bases_changeset",
  ];
  const store = new RevisionedLayerStore(
    'store "top"',
    ctx,
    { type: "Store", id: "top" },
    connection,
    schema,
    "top",
    [person],
    [knows],
    bookkeeping("graph_layers", ["id", "name", "head_revision", "created_at", "created_by_type", "created_by_id"]) as never,
    bookkeeping("graph_changesets", changesetColumns) as never,
    bookkeeping("graph_changeset_bases", [
      "id", "changeset_id", "position", "base_layer_id", "base_revision",
    ]) as never,
  );
  await store.openSession(session, DRAFT, createCancellationSource());
  return { store, person, knows };
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
const here = { draft: DRAFT, parent: "7", bases: NO_BASES };
const atHead = { revision: "7" };

describe("a tail the revisioned store does not follow", () => {
  for (const [method, listing] of Object.entries(listings)) {
    const refused = async (after: string, ctx?: InvokeContext, parent?: string, stacked = false) => {
      const statements: unknown[][] = [];
      const bookkeepingReads: unknown[][] = [];
      expect(
        await listing(after, ctx)(await storeOver(statements, parent, bookkeepingReads, stacked)),
      ).toEqual({ status: "cursorInvalid" });
      // No statement over the graph's tables is issued, and the reads of the
      // store's own bookkeeping that precede the check name nothing of the tail.
      expect(statements).toEqual([]);
      expect(bookkeepingReads.flatMap((read) => [...(read[0] as string[]), ...(read[1] as unknown[])]))
        .not.toContain("p00042");
    };
    const natural = sessionOnly.has(method) ? inSession : undefined;

    it(`is cursorInvalid on ${method} when it is not one this store wrote`, async () => {
      await refused('{"k":[["x","p00042"]]}', natural);
      await refused(encodeKeyTail(keys(method, "p00042")), natural);
      // A tail pinned to nothing: every tail of this store names a revision or a draft.
      await refused(encodeSelectedTail(keys(method, "p00042")), natural);
    });

    it(`is cursorInvalid on ${method} when it was read from another draft`, async () => {
      await refused(
        encodePinnedTail(keys(method, "p00042"), {
          draft: "gdr_BBBBBBBBBBBBBBBBBBBBBB",
          parent: "7",
          bases: NO_BASES,
        }),
        inSession,
      );
    });

    it(`is cursorInvalid on ${method} when the draft was rebased since`, async () => {
      await refused(encodePinnedTail(keys(method, "p00042"), here), inSession, "8");
    });

    it(`is cursorInvalid on ${method} when a pin of the draft moved since`, async () => {
      // Read while the draft pinned nothing, and while it pinned an earlier revision.
      await refused(encodePinnedTail(keys(method, "p00042"), here), inSession, "7", true);
      await refused(
        encodePinnedTail(keys(method, "p00042"), {
          ...here,
          bases: baseListDigest([{ layer: "base", revision: 2n }]),
        }),
        inSession,
        "7",
        true,
      );
      // A tail naming no base list at all is none this store wrote.
      await refused(JSON.stringify({ k: keys(method, "p00042").map((k) => ["s", k]), d: DRAFT, p: "7" }), inSession);
    });

    if (!sessionOnly.has(method)) {
      it(`is cursorInvalid on ${method} across the session boundary, either way`, async () => {
        await refused(encodePinnedTail(keys(method, "p00042"), here), undefined);
        await refused(encodePinnedTail(keys(method, "p00042"), atHead), inSession);
      });

      it(`is cursorInvalid on ${method} when it is pinned past the layer's head`, async () => {
        await refused(encodePinnedTail(keys(method, "p00042"), { revision: "8" }), undefined);
      });
    }
  }
});

describe("a tail the revisioned store follows", () => {
  const hostile = "p' OR 1=1; DROP TABLE people; --";

  // A relationship conflict listing first asks which endpoint nodes the draft
  // withdraws — a statement that names nothing of the tail.
  const statementsOf = (method: string) => (method === "relationshipConflicts" ? 2 : 1);

  async function issued(call: (subject: Subject) => Promise<unknown>, stacked = false, count = 1) {
    const statements: unknown[][] = [];
    await call(await storeOver(statements, "7", [], stacked));
    expect(statements).toHaveLength(count);
    const [fragments, values] = statements[statements.length - 1];
    for (const [, before] of statements.slice(0, -1)) {
      expect(before).not.toContain("p00042");
      expect(before).not.toContain(hostile);
    }
    return { text: JSON.stringify(fragments), values: values as unknown[] };
  }

  for (const [method, listing] of Object.entries(listings)) {
    it(`reaches ${method}'s statement only as a bound value, inside a session`, async () => {
      const tail = (key: string) => encodePinnedTail(keys(method, key), here);
      const benign = await issued(listing(tail("p00042"), inSession), false, statementsOf(method));
      const attack = await issued(listing(tail(hostile), inSession), false, statementsOf(method));
      expect(attack.text).toBe(benign.text);
      expect(attack.text).not.toContain("DROP");
      expect(attack.values).toContain(hostile);
      // The selector is re-checked in code and never reaches the engine.
      expect(attack.text).not.toContain(DRAFT);
      expect(attack.values).not.toContain(DRAFT);
    });
  }

  it("reads at the revision a head tail is pinned to, as a bound value", async () => {
    const pinned = await issued(
      listings.findNodes(encodePinnedTail(["p00042"], { revision: "5" }), undefined),
    );
    const head = await issued(listings.findNodes(encodePinnedTail(["p00042"], atHead), undefined));
    expect(pinned.text).toBe(head.text);
    expect(pinned.values).toContain(5n);
    expect(pinned.values).not.toContain(7n);
    expect(head.values).toContain(7n);
  });

  it("binds the layer and changeset ids, so none reaches statement text", async () => {
    const { text, values } = await issued(
      listings.findNodes(encodePinnedTail(["p00042"], here), inSession),
    );
    expect(text).not.toContain("id-top");
    expect(text).not.toContain("changeset-1");
    expect(values).toEqual(expect.arrayContaining(["id-top", "changeset-1"]));
  });

  for (const [method, listing] of Object.entries(listings)) {
    it(`reads ${method} over a pinned base at the pinned revision, both as bound values`, async () => {
      const tail = encodePinnedTail(keys(method, "p00042"), {
        ...here,
        bases: baseListDigest(PINNED),
      });
      const { text, values } = await issued(listing(tail, inSession), true, statementsOf(method));
      expect(text).not.toContain("id-base");
      expect(text).not.toContain(baseListDigest(PINNED));
      expect(values).toEqual(expect.arrayContaining(["id-base", 3n]));
      expect(values).not.toContain(baseListDigest(PINNED));
    });
  }
});

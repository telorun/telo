import type { InvokeContext, ResourceContext } from "@telorun/sdk";
import type { DeclaredTable, SqlConnection, SqlInstantSchema } from "@telorun/sql";
import { describe, expect, it } from "vitest";
import { DraftedLayerStore } from "../src/drafted-store.js";
import { LayeredNodeType } from "../src/node-type.js";

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

const people = {
  name: "people",
  columns: ["id", "name", "nick", ...INTERNAL].map(column),
  internalColumns: INTERNAL,
  indexes: [],
  foreignKeys: [],
  checks: [],
} as unknown as DeclaredTable;

const bookkeeping = (name: string, columns: string[]) => ({
  table: `"${name}"`,
  ...Object.fromEntries(columns.map((c) => [c, `"${c}"`])),
});

const published = (layer: string, name: string) => ({
  id: "p1",
  name,
  nick: null,
  graph_layer: layer,
  graph_state: "published",
  graph_effect: "stated",
  graph_revision: "1",
  graph_over: null,
});

/**
 * Layer `top` over `middle` over `base`, outside any session, on a scripted
 * connection. `winners` is what each successive read of the winner beneath
 * answers, the last one repeating; `copies` what each successive copy returns,
 * none once it runs out — a copy returning no row is one whose source is gone.
 * Every statement on the typed table that is not a read is recorded, as is
 * whether the layer's revision was advanced.
 */
function storeOverVanishingBase(
  winners: Record<string, unknown>[][] = [[published("id-base", "Base")]],
  copies: Record<string, unknown>[][] = [],
) {
  let winnerReads = 0;
  let copied = 0;
  const writes: string[] = [];
  const advanced: string[] = [];
  const connection = {
    dialect: { quoteIdentifier: (name: string) => `"${name}"` },
    hasOpenTransaction: () => false,
    runInTransaction: (body: (bind: (zone: unknown) => void) => Promise<unknown>) => body(() => {}),
    executeTemplate: async (fragments: string[]) => {
      const text = fragments.join("?");
      if (text.startsWith('SELECT "id", "name" FROM "graph_layers"')) {
        return {
          rows: [
            { id: "id-top", name: "top" },
            { id: "id-middle", name: "middle" },
            { id: "id-base", name: "base" },
          ],
        };
      }
      if (text.includes('"head_revision" + 1')) {
        advanced.push(text);
        return { rows: [] };
      }
      if (text.startsWith('UPDATE "graph_layers"')) return { rows: [{ head_revision: "3" }] };
      if (text.startsWith("SELECT")) {
        // The layer's own rows: none. The winner beneath: as scripted.
        if (text.includes('"graph_state" IN (')) return { rows: [] };
        const rows = winners[Math.min(winnerReads, winners.length - 1)];
        winnerReads += 1;
        return { rows };
      }
      writes.push(text);
      if (text.includes(") VALUES (")) return { rows: [published("id-top", "New")] };
      const rows = copies[copied] ?? [];
      copied += 1;
      return { rows };
    },
  } as unknown as SqlConnection;
  const schema = {
    qualifiedTableName: (declared: DeclaredTable) => `"${declared.name}"`,
    currentInstant: () => "CURRENT_INSTANT",
  } as unknown as SqlInstantSchema;
  const person = new LayeredNodeType("id", { declaration: people });
  const store = (name: string, bases: DraftedLayerStore[]) =>
    new DraftedLayerStore(
      `store "${name}"`,
      {
        self: { ref: { kind: "Layers.Store" } },
        zonesFor: (instance: unknown, context?: InvokeContext) => context?.zones ?? [],
      } as unknown as ResourceContext,
      { type: "store", id: name },
      connection,
      schema,
      name,
      bases,
      [person],
      [],
      bookkeeping("graph_layers", ["id", "name", "head_revision", "created_at", "created_by_type", "created_by_id"]) as never,
      bookkeeping("graph_drafts", [
        "id", "public_id", "layer_id", "parent_revision", "message", "created_at",
        "created_by_type", "created_by_id", "published_at", "published_by_type",
        "published_by_id", "discarded_at", "discarded_by_type", "discarded_by_id", "revision",
      ]) as never,
    );
  const top = store("top", [store("middle", [store("base", [])])]);
  return { store: top, person, writes, advanced };
}

describe("a write whose source a concurrent delete removed", () => {
  it("answers an update as absent and writes nothing more", async () => {
    const { store, person, writes, advanced } = storeOverVanishingBase();

    const result = await store.updateNode(person, "p1", { name: "New" });

    expect(result).toEqual({ status: "absent" });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^INSERT INTO "people" \(.*\) SELECT /);
    expect(advanced).toEqual([]);
  });

  it("states a merge as a new value, naming only the given columns", async () => {
    const { store, person, writes, advanced } = storeOverVanishingBase();

    const result = await store.mergeNode(person, "p1", { name: "New" });

    expect(result).toEqual({
      status: "found",
      value: { key: "p1", properties: { name: "New" }, origin: "top" },
    });
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatch(/^INSERT INTO "people" \(.*\) SELECT /);
    expect(writes[1]).toMatch(/^INSERT INTO "people" \([^)]*"graph_resolved_by_id", "id", "name"\) VALUES \(/);
    expect(advanced).toHaveLength(1);
  });

  it("hides the value a lower layer still shows, and answers a delete as found", async () => {
    const removal = { ...published("id-top", "Base"), graph_effect: "removed" };
    const { store, person, writes, advanced } = storeOverVanishingBase(
      [[published("id-middle", "Middle")], [published("id-base", "Base")]],
      [[], [removal]],
    );

    const result = await store.deleteNode(person, "p1");

    expect(result).toEqual({
      status: "found",
      value: { key: "p1", properties: { name: "Base" }, origin: "base" },
    });
    expect(writes).toHaveLength(2);
    for (const write of writes) expect(write).toMatch(/^INSERT INTO "people" \(.*\) SELECT .*'removed'/);
    expect(advanced).toHaveLength(1);
  });

  it("answers a delete as absent when nothing shows the key any more", async () => {
    const { store, person, writes, advanced } = storeOverVanishingBase(
      [[published("id-middle", "Middle")], []],
    );

    const result = await store.deleteNode(person, "p1");

    expect(result).toEqual({ status: "absent" });
    expect(writes).toHaveLength(1);
    expect(advanced).toEqual([]);
  });

  it("refuses to follow a source that vanishes more often than the stack has layers", async () => {
    const { store, person } = storeOverVanishingBase([[published("id-middle", "Middle")]]);

    await expect(store.deleteNode(person, "p1")).rejects.toThrow(/than the stack has layers \(3\)/);
  });
});

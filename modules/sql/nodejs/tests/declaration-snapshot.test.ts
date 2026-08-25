import { describe, expect, it } from "vitest";
import { parseObjectKey } from "../src/schema/declaration-snapshot.js";
import { objectKey } from "../src/schema/declared-schema.js";
import { seedRowId, seedRowKey } from "../src/schema/seed-rows.js";

/**
 * `objectKey` and `parseObjectKey` are inverses, and a seed row is what makes
 * that non-trivial: its identity embeds the key column VALUES, which are
 * whatever the author declared.
 */
describe("object keys round-trip", () => {
  const roundTrips = (id: Parameters<typeof objectKey>[0]) =>
    expect(parseObjectKey(objectKey(id))).toEqual(id);

  it("keeps a top-level object's own name whole", () => {
    roundTrips({ kind: "table", table: "orders" });
    roundTrips({ kind: "enum", table: "message_role" });
    roundTrips({ kind: "extension", table: "citext" });
  });

  it("splits a child at its table", () => {
    roundTrips({ kind: "column", table: "orders", name: "id" });
    roundTrips({ kind: "check", table: "orders", name: "positive" });
  });

  // `split(":", 2)` returns the first two fields and DISCARDS the rest, so a row
  // keyed on an ISO timestamp came back as `at="2024-01-01T00` — a name that
  // names nothing, and a key that no longer survives the rename rewrite.
  it("keeps a seed-row value containing the separators", () => {
    const seeds = { key: ["at"], rows: [], when: true };
    const id = seedRowId("events", seedRowKey(seeds, { at: "2024-01-01T00:00:00Z" }));
    roundTrips(id);
    expect(parseObjectKey(objectKey(id)).name).toBe('at="2024-01-01T00:00:00Z"');
  });

  it("keeps a seed-row value containing a dot", () => {
    const seeds = { key: ["slug"], rows: [], when: true };
    roundTrips(seedRowId("pages", seedRowKey(seeds, { slug: "a.b.c" })));
  });
});

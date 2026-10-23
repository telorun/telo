import type { ResourceContext } from "@telorun/sdk";
import type { SqlConnection } from "@telorun/sql";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { create } from "../src/store.js";

const connection = {
  kysely: {} as Kysely<any>,
  execute: async () => ({ rows: [] }),
} as unknown as SqlConnection;

const ctx = {
  resolveRef: (value: unknown) => value,
} as unknown as ResourceContext;

describe("dimensions computed by CEL", () => {
  it("bounds vectors as the literal does when it arrives as an int64", async () => {
    const store = await create(
      { metadata: { name: "index" }, connection, dimensions: 3n },
      ctx,
    );
    await expect(store.upsert([{ id: "a", vector: [1, 2, 3] }])).resolves.toEqual({
      ids: ["a"],
    });
    await expect(store.upsert([{ id: "b", vector: [1, 2] }])).rejects.toThrow(
      "VectorStorePgvector: expected vector of length 3, got 2.",
    );
  });
});

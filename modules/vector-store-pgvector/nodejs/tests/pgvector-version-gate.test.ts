import type { ResourceContext } from "@telorun/sdk";
import type { SqlConnection } from "@telorun/sql";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { create } from "../src/store.js";

/** A connection whose database reports pgvector `version`. */
function connectionReporting(version: string): SqlConnection {
  return {
    kysely: {} as Kysely<any>,
    execute: async (sql: string) => ({
      rows: sql.includes("pg_extension") ? [{ extversion: version }] : [],
    }),
  } as unknown as SqlConnection;
}

const ctx = {
  resolveRef: (value: unknown) => value,
} as unknown as ResourceContext;

describe("pgvector version gate", () => {
  it("refuses a pgvector older than 0.8.0 at start-up, naming the version and the remedy", async () => {
    const store = await create(
      { metadata: { name: "index" }, connection: connectionReporting("0.7.4"), dimensions: 3 },
      ctx,
    );
    const error = await store.init().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const { message } = error as Error;
    expect(message).toContain("pgvector 0.7.4 is installed");
    expect(message).toContain(">=0.8.0");
    expect(message).toContain("ALTER EXTENSION vector UPDATE");
  });
});

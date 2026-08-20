import { describe, expect, it } from "vitest";
import { ledgerTables } from "../src/schema/schema-ledger.js";

/**
 * The ledger's identity is its table names — the separation every tool in this
 * space uses — so this is what two schema resources over one namespace rely on
 * to keep their histories apart, and what makes renaming a resource free.
 */
describe("ledgerTables", () => {
  it("defaults to the reserved root", () => {
    expect(ledgerTables()).toEqual({
      migrations: "telo_schema_migrations",
      versions: "telo_schema_versions",
      tombstones: "telo_schema_tombstones",
    });
  });

  it("qualifies a named ledger under the same root", () => {
    expect(ledgerTables("billing")).toEqual({
      migrations: "telo_schema_billing_migrations",
      versions: "telo_schema_billing_versions",
      tombstones: "telo_schema_billing_tombstones",
    });
  });

  it("keeps two named ledgers disjoint", () => {
    const a = Object.values(ledgerTables("a"));
    const b = Object.values(ledgerTables("b"));
    expect(a.some((name) => b.includes(name))).toBe(false);
  });

  it("keeps a named ledger disjoint from the default", () => {
    const named = Object.values(ledgerTables("x"));
    expect(Object.values(ledgerTables()).some((name) => named.includes(name))).toBe(false);
  });

  it("stays inside PostgreSQL's 63-byte identifier limit for a plausible name", () => {
    const longest = ledgerTables("a".repeat(40)).tombstones;
    expect(longest.length).toBeLessThanOrEqual(63);
  });
});

import { isRefSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import {
  findPendingRefCreate,
  pendingRefCreate,
  resolvePendingRefCreate,
  resolveRefCandidates,
  toRefValue,
} from "./ref-candidates";
import type { ResolvedResourceOption } from "./types";

const resources: ResolvedResourceOption[] = [
  { kind: "console.WriteLine", name: "say", capability: "Telo.Invocable" },
  { kind: "kv-store-sql.Store", name: "store", capability: "Telo.Provider" },
  { kind: "run.Sequence", name: "boot", capability: "Telo.Runnable" },
] as ResolvedResourceOption[];

/** With no registry the heuristic is the only path — the case that matters,
 *  since `acceptedKindsForRef` returns undefined for any ref it can't resolve. */
describe("resolveRefCandidates without a registry", () => {
  it("matches a built-in capability through the dotted form", () => {
    expect(resolveRefCandidates(["Telo.Invocable"], resources).map((r) => r.name)).toEqual(["say"]);
  });

  it("matches a kind suffix through an alias prefix", () => {
    expect(resolveRefCandidates(["KvStore.Store"], resources).map((r) => r.name)).toEqual(["store"]);
  });

  it("matches a kind suffix through the canonical module prefix", () => {
    expect(resolveRefCandidates(["kv-store.Store"], resources).map((r) => r.name)).toEqual([
      "store",
    ]);
  });

  it("still reads the legacy identity form", () => {
    expect(resolveRefCandidates(["telo#Invocable"], resources).map((r) => r.name)).toEqual(["say"]);
    expect(resolveRefCandidates(["std/kv-store#Store"], resources).map((r) => r.name)).toEqual([
      "store",
    ]);
  });

  it("dedupes across a union of targets", () => {
    expect(
      resolveRefCandidates(["Telo.Invocable", "console.WriteLine"], resources).map((r) => r.name),
    ).toEqual(["say"]);
  });

  it("yields nothing for a target with no separator", () => {
    expect(resolveRefCandidates(["Invocable"], resources)).toEqual([]);
  });
});

describe("pending ref create", () => {
  it("finds the marker wherever the form put it, and replaces just that node", () => {
    const values = {
      schema: "public",
      tables: [{ name: "users" }, { ref: pendingRefCreate("Postgres.Table") }],
    };

    const pending = findPendingRefCreate(values);
    expect(pending).toEqual({ path: ["tables", 1, "ref"], kind: "Postgres.Table" });

    const resolved = resolvePendingRefCreate(
      values,
      pending!.path,
      pending!.kind,
      "table1",
    ) as typeof values;
    expect(resolved.tables[0]).toEqual({ name: "users" });
    expect(isRefSentinel((resolved.tables[1] as Record<string, unknown>).ref)).toBe(true);
    // The source is untouched — the form's values are re-derived, never mutated.
    expect(findPendingRefCreate(values)).toBeDefined();
    expect(findPendingRefCreate(resolved)).toBeUndefined();
  });

  it("reports nothing when no slot is waiting on a new resource", () => {
    expect(findPendingRefCreate({ a: 1, b: [{ c: "x" }] })).toBeUndefined();
  });

  it("does not descend into a tagged sentinel", () => {
    // A `!ref` / `!cel` value is an opaque leaf; walking into its internals
    // would be reading a YAML tag as if it were form data.
    expect(findPendingRefCreate({ conn: toRefValue({ kind: "Postgres.Connection", name: "db" }) })).toBeUndefined();
  });

  it("replaces a whole-value marker at the root", () => {
    const out = resolvePendingRefCreate(pendingRefCreate("X.Y"), [], "X.Y", "y1");
    expect(isRefSentinel(out)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { resolveRefCandidates } from "./ref-candidates";
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

import { describe, expect, it } from "vitest";
import { impactClosure, reverseTopologicalOrder } from "../src/resource-edges.js";

/** The shape `teardownOrder` passes: a map key paired with something carrying
 *  the resource's name. Reduced to the name itself here — neither function
 *  knows what a resource is. */
const entries = (...names: string[]): Array<readonly [string, string]> =>
  names.map((name) => [name, name] as const);

const deps = (map: Record<string, string[]>): ((name: string) => string[] | undefined) =>
  (name) => map[name];

const ordered = (names: string[], map: Record<string, string[]>): string[] =>
  reverseTopologicalOrder(entries(...names), (v) => v, deps(map)).map(([, v]) => v);

describe("reverseTopologicalOrder", () => {
  it("puts a consumer before what it holds, whatever order it is given in", () => {
    expect(ordered(["db", "repo"], { repo: ["db"] })).toEqual(["repo", "db"]);
    expect(ordered(["repo", "db"], { repo: ["db"] })).toEqual(["repo", "db"]);
  });

  it("keeps the caller's order among resources that do not constrain each other", () => {
    expect(ordered(["a", "b", "c"], {})).toEqual(["a", "b", "c"]);
  });

  it("orders a chain from the top down", () => {
    const map = { api: ["repo"], repo: ["db"] };
    expect(ordered(["db", "repo", "api"], map)).toEqual(["api", "repo", "db"]);
  });

  it("ignores an edge to a resource outside the set", () => {
    // A tier holds only some of the context's resources, and an edge crossing
    // out of it is not this tier's to order.
    expect(ordered(["repo"], { repo: ["db", "logger"] })).toEqual(["repo"]);
  });

  it("emits every resource exactly once when a cycle makes none of them ready", () => {
    // Teardown must always run to completion, so a cycle degrades to the
    // caller's order rather than raising or dropping an entry.
    const cyclic = ordered(["a", "b"], { a: ["b"], b: ["a"] });
    expect([...cyclic].sort()).toEqual(["a", "b"]);
  });

  it("tolerates a resource that depends on itself", () => {
    expect(ordered(["a", "b"], { a: ["a"], b: [] })).toEqual(["a", "b"]);
  });
});

describe("impactClosure", () => {
  const map = (o: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(o));

  it("includes the seeds themselves", () => {
    expect([...impactClosure(["db"], map({}))]).toEqual(["db"]);
  });

  it("pulls in a direct holder", () => {
    const impacted = impactClosure(["db"], map({ repo: ["db"] }));
    expect([...impacted].sort()).toEqual(["db", "repo"]);
  });

  it("pulls in holders transitively", () => {
    // Rebuilding `db` leaves `repo` pointing at a dead instance, and `api`
    // pointing at a `repo` that is about to be one.
    const impacted = impactClosure(["db"], map({ api: ["repo"], repo: ["db"] }));
    expect([...impacted].sort()).toEqual(["api", "db", "repo"]);
  });

  it("leaves an unrelated branch alone", () => {
    const impacted = impactClosure(["db"], map({ repo: ["db"], mailer: ["smtp"] }));
    expect([...impacted].sort()).toEqual(["db", "repo"]);
  });

  it("does not follow an edge backwards", () => {
    // `repo` holds `db`; rebuilding `repo` says nothing about `db`.
    expect([...impactClosure(["repo"], map({ repo: ["db"] }))]).toEqual(["repo"]);
  });

  it("terminates on a cycle", () => {
    const impacted = impactClosure(["a"], map({ a: ["b"], b: ["a"] }));
    expect([...impacted].sort()).toEqual(["a", "b"]);
  });

  it("takes several seeds at once", () => {
    const impacted = impactClosure(["db", "smtp"], map({ repo: ["db"], mailer: ["smtp"] }));
    expect([...impacted].sort()).toEqual(["db", "mailer", "repo", "smtp"]);
  });

  it("is empty for no seeds", () => {
    expect(impactClosure([], map({ repo: ["db"] })).size).toBe(0);
  });
});

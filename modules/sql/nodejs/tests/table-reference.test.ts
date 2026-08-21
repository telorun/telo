import { describe, expect, it } from "vitest";
import type { ResourceContext, ResourceManifest } from "@telorun/sdk";
import { tableReferenceResolver } from "../src/schema/table-reference.js";

/**
 * A `references.table` slot, resolved to the referenced table's physical name.
 *
 * The cases that matter are the two SHAPES the slot can hold. Which one arrives
 * is a race with Phase-5 injection, so a resolver that reads only one of them
 * works on some passes of the init loop and not others — which is exactly how
 * every cross-table foreign key came to fail.
 */
describe("tableReferenceResolver", () => {
  const ctx = (declared: Record<string, ResourceManifest>): ResourceContext =>
    ({ resolveDeclaredManifest: (name: string) => declared[name] }) as unknown as ResourceContext;

  const users = { kind: "X.Table", metadata: { name: "users" }, table: "users_t" } as ResourceManifest;
  const resolve = (value: unknown, declared = { users }) =>
    tableReferenceResolver(ctx(declared), "X.Table", "sessions")(value, "fk");

  it("reads the name off the DECLARATION when the reference is unresolved", () => {
    expect(resolve({ kind: "X.Table", name: "users" })).toBe("users_t");
  });

  it("reads the name off the instance when injection got there first", () => {
    expect(resolve({ table: "users_t" })).toBe("users_t");
  });

  it("takes a plain string as the name it already is", () => {
    expect(resolve("users_t")).toBe("users_t");
  });

  it("says which name it could not resolve", () => {
    expect(() => resolve({ kind: "X.Table", name: "absent" })).toThrow(
      /names 'absent', which resolves to no declared resource/,
    );
  });

  // The kind is constrained statically by `x-telo-ref`, so this is a backstop —
  // but one that must refuse, since any resource carrying a `table` field would
  // otherwise put a wrong identifier into DDL.
  it("refuses a reference to a resource of another kind", () => {
    const repo = { kind: "X.Repository", metadata: { name: "r" }, table: "users_t" } as ResourceManifest;
    expect(() => resolve({ kind: "X.Table", name: "r" }, { users, r: repo } as any)).toThrow(
      /is a X.Repository, not a X.Table/,
    );
  });

  it("refuses a target that declares no table", () => {
    const bare = { kind: "X.Table", metadata: { name: "b" } } as ResourceManifest;
    expect(() => resolve({ kind: "X.Table", name: "b" }, { users, b: bare } as any)).toThrow(
      /declares no 'table'/,
    );
  });

  it("names the foreign key and the table that declared it", () => {
    expect(() => resolve({ kind: "X.Table", name: "absent" })).toThrow(
      /X.Table 'sessions': foreign key 'fk': 'references.table'/,
    );
  });
});

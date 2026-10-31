import { describe, expect, it } from "vitest";
import { kindRef, resolveRefInstance, type ModuleContext } from "../src/index.js";

/** A reference is told by the rule the kernel applies: the `__ref` marker, or a
 *  `!ref` sentinel. A plain `{ kind, name }` is an inline declaration. */
describe("resolveRefInstance", () => {
  const store = { get: () => undefined };
  const imported = { get: () => "imported" };
  const ctx = {
    moduleContext: {
      getInstance: (name: string) => (name === "store" ? store : undefined),
      resolveImportedInstance: (alias: string, name: string) =>
        alias === "Lib" && name === "store" ? imported : undefined,
    } as unknown as ModuleContext,
  };
  const isStore = (value: unknown): value is typeof store =>
    typeof (value as { get?: unknown } | null)?.get === "function";
  const resolve = (value: unknown) => resolveRefInstance(value, ctx, isStore, () => `'store'`, "Cache.Store");

  it("resolves a marked reference, and a `!ref` sentinel by the name it holds", () => {
    expect(resolve(kindRef("Cache.Memory", "store"))).toBe(store);
    // As the loader makes them: the `!ref` engine's verdict beside the text.
    const sentinel = (source: string, alias?: string) => ({
      __tagged: true,
      engine: "ref",
      source,
      parsed: { ...(alias ? { alias } : {}), name: "store", indexes: [] },
    });
    expect(resolve(sentinel("store"))).toBe(store);
    expect(resolve(sentinel("Self.store", "Self"))).toBe(store);
    expect(resolve(sentinel("Lib.store", "Lib"))).toBe(imported);
  });

  it("reads a plain `{ kind, name }` as no reference", () => {
    expect(() => resolve({ kind: "Cache.Memory", name: "store" })).toThrowError(
      "'store' must be a `!ref` to a resource satisfying `Cache.Store`.",
    );
  });
});

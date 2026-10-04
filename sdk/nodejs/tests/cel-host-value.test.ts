import { celMapFromEntries, celUint, isCelMap } from "@telorun/cel";
import { describe, expect, it } from "vitest";
import { hostValueOf } from "../src/cel-host-value.js";

/**
 * The one seam a CEL value crosses on its way out to a host reader.
 *
 * **What this gate's filter cannot reach:** it asks what the seam ANSWERS, so it says
 * nothing about which boundaries call it. Every one of the failures that produced it was a
 * boundary that did not — the arguments of a module function's call, the argument of
 * `json()` — so each caller is pinned where it lives (`templating/tests/module-call.test.ts`,
 * `kernel/tests/cel-handlers.test.ts`) and a row that passes this filter and is still wrong
 * is a NEW boundary nobody has routed through it. Nothing here can see one.
 */
describe("hostValueOf", () => {
  const stringKeyed = celMapFromEntries(["a", 1n, "b", ["x"]]);
  const intKeyed = celMapFromEntries([1n, "one", 2n, "two"]);

  it("writes an all-string-key map as the plain object every host reader can read", () => {
    const host = hostValueOf(stringKeyed);
    // A reader saw `{"entries":{}}` before: the carrier, not the contents.
    expect(host).toEqual({ a: 1n, b: ["x"] });
    expect(Object.keys(host as object)).toEqual(["a", "b"]);
    expect(isCelMap(host)).toBe(false);
    // Prototype-free would be a third representation; a host hands a map over as a
    // plain object, which is what every reader's own walk tests for.
    expect(Object.getPrototypeOf(host as object)).toBe(Object.prototype);
  });

  it("leaves a map with a non-string key exactly as it is", () => {
    // A plain object holds no other key type, so converting would collapse CEL's four
    // key types to text — the one thing the typed-key domain exists to prevent.
    expect(hostValueOf(intKeyed)).toBe(intKeyed);
  });

  it("converts a map nested in a list, a record and another map", () => {
    const nested = celMapFromEntries(["inner", stringKeyed]);
    expect(hostValueOf([stringKeyed])).toEqual([{ a: 1n, b: ["x"] }]);
    expect(hostValueOf({ held: stringKeyed })).toEqual({ held: { a: 1n, b: ["x"] } });
    expect(hostValueOf(nested)).toEqual({ inner: { a: 1n, b: ["x"] } });
  });

  it("answers by identity where nothing moved, so an unchanged tree costs no allocation", () => {
    const plain = { a: 1n, b: [2n] };
    expect(hostValueOf(plain)).toBe(plain);
    expect(hostValueOf(plain.b)).toBe(plain.b);
  });

  it("carries every other value of the domain through unchanged", () => {
    // It converts the map REPRESENTATION and nothing else: a host reader of a typed slot
    // receives the value its contract declares, so writing one as text is not this seam's.
    const uint = celUint(7n);
    const bytes = new Uint8Array([1, 2]);
    expect(hostValueOf(uint)).toBe(uint);
    expect(hostValueOf(bytes)).toBe(bytes);
    expect(hostValueOf(null)).toBe(null);
    expect(hostValueOf("text")).toBe("text");
    expect(hostValueOf(9n)).toBe(9n);
  });
});

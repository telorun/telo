import { celDurationFromNanos, isCelDuration } from "@telorun/cel";
import { describe, expect, it } from "vitest";
import { celHostScopeValue } from "../src/cel-host-scope-value.js";

/** A framework's own bag: prototype-free data by intent, which the member-read
 *  seam cannot read. This is the exact shape fastify's query parser builds. */
function bag(entries: Record<string, unknown>): object {
  const holder = Object.create(Object.create(null) as object) as Record<string, unknown>;
  for (const [key, value] of Object.entries(entries)) holder[key] = value;
  return holder;
}

describe("a host value entering a CEL activation", () => {
  it("brings prototype-free data into the domain", () => {
    const out = celHostScopeValue(bag({ page: "2" })) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.page).toBe("2");
  });

  it("returns a value already readable by identity", () => {
    const plain = { a: 1 };
    expect(celHostScopeValue(plain)).toBe(plain);
    const nullProto = Object.assign(Object.create(null) as object, { a: 1 });
    expect(celHostScopeValue(nullProto)).toBe(nullProto);
  });

  /**
   * The bug this file exists for. A converted value is a COPY of a bag the
   * framework still owns, and a route's validator coerces the query IN PLACE —
   * after a request guard has already read the binding. Memoizing the copy
   * served the guard's pre-coercion snapshot to the handler, so a boolean query
   * parameter arrived as the string it was parsed as and failed the contract it
   * was declared against.
   */
  it("re-reads a bag the host mutated after it was first converted", () => {
    const live = bag({ archived: "true" }) as Record<string, unknown>;
    expect((celHostScopeValue(live) as Record<string, unknown>).archived).toBe("true");
    live.archived = true; // what a coercing validator does, in place
    expect((celHostScopeValue(live) as Record<string, unknown>).archived).toBe(true);
  });

  it("leaves a value that keeps a real prototype alone", () => {
    for (const held of [new Date(0), new Map([["a", 1]]), new Uint8Array([1, 2]), /x/]) {
      expect(celHostScopeValue(held)).toBe(held);
    }
  });

  /** A brand is a plain object, so it reaches the readable branch — and
   *  rebuilding one from its entries would drop the symbol it carries its type
   *  under, turning a duration into a pair of numbers. */
  it("never rebuilds a branded value", () => {
    const duration = celDurationFromNanos(90_000_000_000n);
    expect(celHostScopeValue(duration)).toBe(duration);
    const holder = { at: duration, q: bag({ k: "v" }) };
    const out = celHostScopeValue(holder) as Record<string, unknown>;
    expect(out).not.toBe(holder);
    expect(out.at).toBe(duration);
    expect(isCelDuration(out.at)).toBe(true);
  });

  it("converts through a list and a nested member", () => {
    const out = celHostScopeValue([{ q: bag({ k: "v" }) }]) as Array<Record<string, unknown>>;
    const nested = out[0]!.q as Record<string, unknown>;
    expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
    expect(nested.k).toBe("v");
  });
});

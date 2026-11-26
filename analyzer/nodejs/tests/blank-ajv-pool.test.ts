import { describe, expect, it } from "vitest";
import { createAjv, returnBlankAjv, takeBlankAjv } from "../src/schema-validation.js";

const flavour = (name: string) => `blank-ajv-pool-test:${name}`;

const held = (instance: ReturnType<typeof createAjv>) => ({
  keywords: Object.keys(instance.RULES.keywords).sort(),
  schemas: Object.keys(instance.schemas).sort(),
  refs: Object.keys(instance.refs).sort(),
});

describe("the blank AJV instance pool", () => {
  it("hands a returned instance back holding what a fresh one holds, and nothing a reader registered", () => {
    const key = flavour("isolation");
    const first = takeBlankAjv(key, createAjv);
    first.addSchema({ $id: "urn:test:registered", type: "string" });
    first.compile({ type: "number" });
    expect(first.getSchema("urn:test:registered")).toBeDefined();
    returnBlankAjv(first);

    const second = takeBlankAjv(key, createAjv);
    expect(second).toBe(first);
    expect(second.getSchema("urn:test:registered")).toBeUndefined();
    expect(held(second)).toEqual(held(createAjv()));
    returnBlankAjv(second);
  });

  it("drops an instance at its 64th use rather than keeping it", () => {
    const key = flavour("retirement");
    const first = takeBlankAjv(key, createAjv);
    returnBlankAjv(first);
    for (let use = 2; use < 64; use++) {
      const again = takeBlankAjv(key, createAjv);
      expect(again).toBe(first);
      returnBlankAjv(again);
    }
    const last = takeBlankAjv(key, createAjv);
    expect(last).toBe(first);
    returnBlankAjv(last);

    const next = takeBlankAjv(key, createAjv);
    expect(next).not.toBe(first);
    returnBlankAjv(next);
  });
});

import { describe, expect, it } from "vitest";
import { stripCompiledValues } from "../src/schema-compiled-values.js";

/** The load-time wrapper `isCompiledValue` recognizes. */
const cel = (source: string) => ({ __compiled: true, source, evaluate: () => source }) as unknown;

const SCHEMA = {
  type: "object",
  properties: {
    client: { title: "Client", "x-telo-ref": "http-client.Client" },
    url: { type: "string" },
    timeout: { type: "integer", minimum: 1 },
  },
};

describe("stripCompiledValues", () => {
  it("replaces compiled values with schema-appropriate placeholders", () => {
    expect(
      stripCompiledValues({ url: cel("inputs.path"), timeout: cel("self.t") }, SCHEMA),
    ).toEqual({ url: "", timeout: 1 });
  });

  it("hands back a ref slot untouched instead of walking into it", () => {
    // What a template child carries: `client: !cel "self.client"` resolves to the
    // LIVE Http.Client instance Phase 5 injected into the parent, and a real
    // client's object graph points back at itself.
    const live: Record<string, unknown> = { snapshot: () => ({}) };
    live.self = live;

    const out = stripCompiledValues(
      { kind: "Http.Request", client: live, url: cel("x") },
      SCHEMA,
    ) as Record<string, unknown>;

    expect(out.client).toBe(live);
    expect(out.url).toBe("");
  });

  it("does not copy a class instance", () => {
    class Pool {
      constructor(readonly n: number) {}
    }
    const pool = new Pool(3);
    const out = stripCompiledValues({ pool }, { type: "object" }) as Record<string, unknown>;
    expect(out.pool).toBe(pool);
  });

  it("survives a cycle through a slot no annotation covers", () => {
    const node: Record<string, unknown> = { url: cel("x") };
    node.loop = node;

    const out = stripCompiledValues({ nested: node }, { type: "object" }) as any;
    expect(out.nested.url).toBe("");
    expect(out.nested.loop).toBe(node);
  });

  it("still strips a sub-object that merely appears twice", () => {
    // Shared, not cyclic — the guard is ancestor-scoped, so both sites strip.
    const shared = { url: cel("x") };
    const out = stripCompiledValues({ a: shared, b: shared }, { type: "object" }) as any;
    expect(out.a.url).toBe("");
    expect(out.b.url).toBe("");
  });
});

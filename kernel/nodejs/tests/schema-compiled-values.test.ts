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

  it("strips config sitting beside a ref at the same annotated slot", () => {
    // `targets:` annotates the array ITEM, so a bare `!ref Foo` target is a ref
    // slot — but the item may instead be a step object carrying a `when:` guard.
    // Bailing on the annotation alone left that guard a CompiledValue and AJV
    // rejected the whole entry with "/targets/N/when must be string".
    const schema = {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: {
            "x-telo-ref": { kind: "Telo.Runnable", use: "call" },
            anyOf: [
              { type: "string" },
              { type: "object", required: ["kind", "name"] },
              {
                type: "object",
                required: ["ref"],
                properties: { ref: {}, when: { type: "string" } },
              },
            ],
          },
        },
      },
    };

    const out = stripCompiledValues(
      {
        targets: [
          { kind: "Run.Sequence", name: "Bare" },
          { ref: { kind: "Run.Loop", name: "Gated" }, when: cel("variables.on") },
        ],
      },
      schema,
    ) as { targets: Array<Record<string, unknown>> };

    // The resolved ref is still a ref — handed back, not walked into.
    expect(out.targets[0]).toEqual({ kind: "Run.Sequence", name: "Bare" });
    expect(out.targets[1].ref).toEqual({ kind: "Run.Loop", name: "Gated" });
    expect(out.targets[1].when).toBe("");
  });

  it("hands back a live instance that is a plain object with methods", () => {
    // A controller's `create()` may return an object literal, so the prototype
    // check alone does not catch every instance. Copying one is what the ref-slot
    // bail exists to prevent.
    const live: Record<string, unknown> = { invoke: async () => ({}) };
    live.self = live;
    const out = stripCompiledValues({ client: live, url: cel("x") }, SCHEMA) as Record<
      string,
      unknown
    >;
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

import { describe, expect, it } from "vitest";
import { defaultBearingPaths, withStreamPropertiesSkipped } from "@telorun/analyzer";
import { copyForDefaults, resolveBoundContract } from "../src/invocation-contract-binding.js";
import type { ContractValidatorFactory } from "../src/invocation-contract-binding.js";
import { withBigIntsAsNumbers } from "../src/bigint-schema-view.js";

/**
 * Conformance tests for `kernel/specs/invocation-contract.md` §6, mirroring
 * `logging-conformance.test.ts` for the logging spec.
 *
 * The spec is normative for a second-language runtime, so each numbered
 * conformance point needs a test that fails when the behaviour drifts — the
 * defaults copy in particular, whose array case shipped broken because nothing
 * exercised it.
 */

const manifest = (extra: Record<string, unknown> = {}) =>
  ({ kind: "m.K", metadata: { name: "r", module: "m" }, ...extra }) as any;

/** A factory over plain schemas: compiles nothing, records what it was asked to
 *  compile, and reports whether the rules-preserving entry point was used. */
function stubFactory(schema: Record<string, any> | undefined) {
  const calls: Array<{ via: "ref" | "withRules"; arg: unknown }> = [];
  const factory = Object.assign(
    (typeRef: unknown) => {
      calls.push({ via: "ref", arg: typeRef });
      return { validate: () => {} };
    },
    {
      schemaOf: () => schema,
      withRules: (name: string | undefined, s: Record<string, any>) => {
        calls.push({ via: "withRules", arg: { name, schema: s } });
        return { validate: () => {} };
      },
    },
  ) as ContractValidatorFactory;
  return { factory, calls };
}

describe("§4.2 — defaults are filled over a copy deep along default-bearing paths", () => {
  it("copies through an array so a fill cannot reach the caller's elements", () => {
    const schema = {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: { type: "object", properties: { n: { type: "integer", default: 7 } } },
        },
      },
    };
    const paths = defaultBearingPaths(schema);
    expect(paths).toContainEqual(["rows", "[]", "n"]);

    const caller = { rows: [{}, {}] };
    const copy = copyForDefaults(caller, paths) as any;
    copy.rows[0].n = 7;
    copy.rows[1].n = 7;

    // The caller keeps the value it passed. A shared element would make a second
    // invocation observe the first call's defaults.
    expect(caller).toEqual({ rows: [{}, {}] });
  });

  it("copies through nested objects", () => {
    const schema = {
      type: "object",
      properties: { nest: { type: "object", properties: { m: { type: "integer", default: 3 } } } },
    };
    const caller = { nest: {} };
    const copy = copyForDefaults(caller, defaultBearingPaths(schema)) as any;
    copy.nest.m = 3;
    expect(caller).toEqual({ nest: {} });
  });

  it("shares structure off the default-bearing paths", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "object", properties: { x: { type: "integer", default: 1 } } } },
    };
    const untouched = { big: "payload" };
    const caller = { a: {}, other: untouched };
    const copy = copyForDefaults(caller, defaultBearingPaths(schema)) as any;
    // Bounded by the schema's defaults, not by the size of the payload.
    expect(copy.other).toBe(untouched);
  });
});

describe("§4.3 — validation exempts x-telo-stream in both directions", () => {
  it("drops a marked property from properties and required", () => {
    const stripped = withStreamPropertiesSkipped({
      type: "object",
      required: ["input", "encoding"],
      additionalProperties: false,
      properties: {
        input: { "x-telo-stream": true },
        encoding: { type: "string" },
      },
    });
    // The key stays declared but unconstrained, so a live Stream passes while
    // the closed shape keeps rejecting unknown keys.
    expect(stripped.properties.input).toEqual({});
    expect(stripped.required).toEqual(["input", "encoding"]);
    expect(stripped.additionalProperties).toBe(false);
  });

  it("reaches a stream nested below the root", () => {
    const stripped = withStreamPropertiesSkipped({
      type: "object",
      properties: {
        body: {
          type: "object",
          required: ["chunks"],
          properties: { chunks: { "x-telo-stream": true } },
        },
      },
    });
    expect(stripped.properties.body.properties.chunks).toEqual({});
  });

  it("reaches a stream contributed by an allOf branch", () => {
    const stripped = withStreamPropertiesSkipped({
      type: "object",
      allOf: [{ properties: { output: { "x-telo-stream": true } }, required: ["output"] }],
    });
    expect(stripped.allOf[0].properties.output).toEqual({});
  });

  it("leaves a stream-free schema untouched by identity", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    // Identity matters: the validator cache is keyed by schema object.
    expect(withStreamPropertiesSkipped(schema)).toBe(schema);
  });
});

describe("§2.1 — contract resolution layering", () => {
  const scopeless = () => undefined;

  it("prefers the instance declaration over the kind's", () => {
    const { factory, calls } = stubFactory({ type: "object" });
    const bound = resolveBoundContract(
      "inputType",
      manifest({ inputType: { schema: { type: "object" } } }),
      { kind: "Telo.Definition", metadata: { name: "K", module: "m" }, inputType: "Other" } as any,
      scopeless as any,
      factory,
    );
    bound!.validate({});
    // The instance declaration is inline, so it compiles from the resolved
    // schema rather than by name — what matters is that the kind's `Other` was
    // never consulted.
    expect(calls[0]!.via).toBe("ref");
    expect(calls[0]!.arg).not.toBe("Other");
  });

  it("returns undefined when neither declares one — absence is not an empty claim", () => {
    const { factory } = stubFactory(undefined);
    expect(
      resolveBoundContract("inputType", manifest(), undefined, scopeless as any, factory),
    ).toBeUndefined();
  });
});

describe("§5 — a declared contract that cannot be resolved fails loudly", () => {
  it("raises ERR_CONTRACT_UNRESOLVABLE rather than disabling enforcement", () => {
    const { factory } = stubFactory(undefined);
    const bound = resolveBoundContract(
      "inputType",
      manifest({ inputType: "NeverRegistered" }),
      undefined,
      (() => undefined) as any,
      factory,
    );
    expect(bound).toBeDefined();
    expect(() => bound!.validate({})).toThrowError(/ERR_CONTRACT_UNRESOLVABLE|not registered/);
  });
});

describe("a named type keeps its CEL rules even when a stream is stripped", () => {
  it("compiles through the rules-preserving entry point", () => {
    const { factory, calls } = stubFactory({
      type: "object",
      required: ["input", "n"],
      properties: { input: { "x-telo-stream": true }, n: { type: "integer" } },
    });
    const bound = resolveBoundContract(
      "inputType",
      manifest({ inputType: "StreamyType" }),
      undefined,
      (() => undefined) as any,
      factory,
    );
    bound!.validate({});
    // Not `factory(declared)` (which would keep the stream) and not a bare
    // schema (which would drop the rules) — the entry point that does both.
    expect(calls[0]!.via).toBe("withRules");
    expect((calls[0]!.arg as any).name).toBe("StreamyType");
    expect((calls[0]!.arg as any).schema.properties.input).toEqual({});
  });

  it("compiles by name when there is nothing to strip", () => {
    const { factory, calls } = stubFactory({ type: "object", properties: { n: {} } });
    const bound = resolveBoundContract(
      "inputType",
      manifest({ inputType: "PlainType" }),
      undefined,
      (() => undefined) as any,
      factory,
    );
    bound!.validate({});
    expect(calls[0]!.via).toBe("ref");
    expect(calls[0]!.arg).toBe("PlainType");
  });
});

describe("CEL integers satisfy an integer contract", () => {
  it("normalizes BigInt for validation while dispatching the original", () => {
    // CEL evaluates an integer literal to a BigInt, which a JSON Schema
    // validator does not recognise as `integer` — so every computed integer
    // reaching a declared integer input was rejected for a reason no author
    // could act on. Validation sees a normalized view; the callee sees BigInt.
    expect(withBigIntsAsNumbers({ n: 42n })).toEqual({ n: 42 });
    expect(withBigIntsAsNumbers({ rows: [{ n: 7n }] })).toEqual({ rows: [{ n: 7 }] });
  });

  it("passes non-plain objects through by reference", () => {
    class Live {
      readonly marker = 1;
    }
    const live = new Live();
    // A live instance or stream in a declared slot is not data to be walked.
    expect(withBigIntsAsNumbers({ live }).live).toBe(live);
  });

  it("leaves a BigInt-free value identical", () => {
    const value = { a: 1, b: "x" };
    expect(withBigIntsAsNumbers(value)).toBe(value);
  });
});

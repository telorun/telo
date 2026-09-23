import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { AliasResolver } from "../src/alias-resolver.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { DefinitionRegistry } from "../src/definition-registry.js";
import { createResolveCtx, resolveThrowsUnion } from "../src/resolve-throws-union.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** An abstract's `throws:` is the third part of its contract: a ceiling every
 *  descendant's codes must fall within, and the union a dispatch through a
 *  kind-only stand-in resolves to. */

const codes = (...names: string[]) => Object.fromEntries(names.map((n) => [n, { description: n }]));

const lookup = (throws: unknown = { codes: codes("ERR_NOT_FOUND") }) => ({
  kind: "Telo.Abstract",
  metadata: { name: "Lookup", module: "std" },
  capability: "Telo.Invocable",
  ...(throws === null ? {} : { throws }),
});

const store = (throws: unknown) => ({
  kind: "Telo.Definition",
  metadata: { name: "Store", module: "std" },
  extends: "std.Lookup",
  controllers: ["pkg:npm/store@1.0.0"],
  throws,
  schema: { type: "object", properties: {} },
});

const app = {
  kind: "Telo.Application",
  metadata: { name: "app", version: "1.0.0" },
} as unknown as ResourceManifest;

const diagnosticsOf = (docs: unknown[], code: string) =>
  new StaticAnalyzer()
    .analyze(withSyntheticPositions([app, ...(docs as ResourceManifest[])]))
    .filter((d) => d.code === code);

describe("THROWS_NOT_SUBSTITUTABLE", () => {
  it("reports a code the ancestor's ceiling does not admit", () => {
    const found = diagnosticsOf([lookup(), store({ codes: codes("ERR_NOT_FOUND", "ERR_DOWN") })], "THROWS_NOT_SUBSTITUTABLE");
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("throws 'ERR_DOWN', which 'std.Lookup' does not declare");
  });

  it("accepts a subset of the ceiling", () => {
    expect(diagnosticsOf([lookup(), store({ codes: codes("ERR_NOT_FOUND") })], "THROWS_NOT_SUBSTITUTABLE")).toEqual([]);
  });

  it("bounds nothing when no ancestor declares a list", () => {
    expect(diagnosticsOf([lookup(null), store({ codes: codes("ERR_DOWN") })], "THROWS_NOT_SUBSTITUTABLE")).toEqual([]);
  });
});

describe("throws: on a Telo.Abstract", () => {
  it("refuses inherit, which has no body to come from, even set to false", () => {
    for (const inherit of [true, false]) {
      const found = diagnosticsOf([lookup({ inherit, codes: codes("ERR_NOT_FOUND") })], "SCHEMA_VIOLATION");
      expect(found).toHaveLength(1);
      expect(found[0]!.data?.path).toBe("throws");
      expect(found[0]!.message).toContain("inherit");
    }
  });

  it("refuses a code the kernel's schema refuses", () => {
    const found = diagnosticsOf([lookup({ codes: { lowercase_code: {} } })], "SCHEMA_VIOLATION");
    expect(found.length).toBeGreaterThan(0);
  });

  it("refuses a list on a capability with no caller to catch it", () => {
    for (const capability of ["Telo.Service", "Acme.Custom"]) {
      const found = diagnosticsOf([{ ...lookup(), capability }], "THROWS_ON_NON_DISPATCH_CAPABILITY");
      expect(found).toHaveLength(1);
      expect(found[0]!.message).toContain("Telo.Abstract 'Lookup'");
    }
  });
});

describe("a ceiling above a dynamic ancestor", () => {
  it("still bounds the descendants below it", () => {
    const relay = {
      kind: "Telo.Definition",
      metadata: { name: "Relay", module: "std" },
      extends: "std.Lookup",
      controllers: ["pkg:npm/relay@1.0.0"],
      throws: { inherit: true },
      schema: { type: "object", properties: { steps: { type: "array", items: { $ref: "telo://manifest#/$defs/Step" } } } },
    };
    const leaf = {
      kind: "Telo.Definition",
      metadata: { name: "Leaf", module: "std" },
      extends: "std.Relay",
      controllers: ["pkg:npm/leaf@1.0.0"],
      throws: { codes: codes("ERR_Y") },
      schema: { type: "object", properties: {} },
    };
    const found = diagnosticsOf([lookup(), relay, leaf], "THROWS_NOT_SUBSTITUTABLE");
    expect(found.map((d) => d.data?.resource?.name)).toEqual(["Leaf"]);
    expect(found[0]!.message).toContain("which 'std.Lookup' does not declare");
  });
});

describe("a dispatch through a kind-only stand-in", () => {
  const injected = {
    kind: "std.Lookup",
    metadata: { name: "lookup", xTeloInjected: true },
  } as unknown as ResourceManifest;

  const unionOf = (abstract: unknown) => {
    const registry = new DefinitionRegistry();
    registry.register(abstract as never);
    const union = resolveThrowsUnion(injected, createResolveCtx([injected], registry, new AliasResolver()));
    return { codes: [...union.codes.keys()], unbounded: union.unbounded };
  };

  it("resolves to the kind's ceiling", () => {
    expect(unionOf(lookup())).toEqual({ codes: ["ERR_NOT_FOUND"], unbounded: false });
  });

  it("is unbounded when the kind declares no list, rather than throwing nothing", () => {
    expect(unionOf(lookup(null))).toEqual({ codes: [], unbounded: true });
  });
});

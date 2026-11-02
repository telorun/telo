import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { AliasResolver } from "../src/alias-resolver.js";
import { DefinitionRegistry } from "../src/definition-registry.js";
import { createResolveCtx, resolveThrowsUnion } from "../src/resolve-throws-union.js";

/** A kind's `throws:` resolves to the nearest declaration along `extends`, and an
 *  `inherit` union walks the configuration its controller receives. */

const cel = (source: string) => ({ __tagged: true, engine: "cel", source });
const refSentinel = (source: string) => ({ __tagged: true, engine: "ref", source });

const definition = (name: string, fields: Record<string, unknown>) => ({
  kind: "Telo.Definition",
  metadata: { name, module: "lib" },
  ...fields,
});

const raiseDef = definition("Raise", {
  capability: "Telo.Invocable",
  controllers: ["pkg:npm/raise@1.0.0"],
  throws: { codes: { RAISED: {} } },
  schema: { type: "object", properties: {} },
});
const otherDef = definition("Other", {
  capability: "Telo.Invocable",
  controllers: ["pkg:npm/other@1.0.0"],
  throws: { codes: { OTHER: {} } },
  schema: { type: "object", properties: {} },
});
const stepsDef = definition("Steps", {
  capability: "Telo.Runnable",
  controllers: ["pkg:npm/steps@1.0.0"],
  throws: { inherit: true },
  schema: {
    type: "object",
    properties: { steps: { type: "array", "x-telo-step-context": { invoke: "invoke" } } },
  },
});

/** The library's `raise` throws RAISED; the consumer's resource of the same name
 *  throws OTHER. */
const libraryRaise = { kind: "lib.Raise", metadata: { name: "raise", module: "lib" } } as unknown as ResourceManifest;
const consumerRaise = { kind: "lib.Other", metadata: { name: "raise", module: "app" } } as unknown as ResourceManifest;

function unionOf(defs: unknown[], declared: ResourceManifest) {
  const registry = new DefinitionRegistry();
  for (const def of [raiseDef, otherDef, stepsDef, ...defs]) registry.register(def as never);
  const all = [libraryRaise, consumerRaise, declared];
  const ctx = createResolveCtx(
    all,
    registry,
    new AliasResolver(),
    new Map(),
    new Set(["app"]),
    new Map([["lib", [libraryRaise]]]),
  );
  const union = resolveThrowsUnion(declared, ctx);
  return { codes: [...union.codes.keys()].sort(), unbounded: union.unbounded };
}

const declared = (kind: string, fields: Record<string, unknown> = {}) =>
  ({ kind, metadata: { name: "declared", module: "app" }, ...fields }) as unknown as ResourceManifest;

describe("throws through extends", () => {
  it("a field-less child of a kind declaring codes presents those codes", () => {
    const child = definition("Child", { extends: "lib.Raise" });
    expect(unionOf([child], declared("lib.Child"))).toEqual({ codes: ["RAISED"], unbounded: false });
  });

  it("a child declaring its own block replaces the ancestor's", () => {
    const child = definition("Child", { extends: "lib.Raise", throws: { codes: {} } });
    expect(unionOf([child], declared("lib.Child"))).toEqual({ codes: [], unbounded: false });
  });

  it("a child with no mapping walks the declaration under its author schema", () => {
    const alias = definition("Alias", { extends: "lib.Steps" });
    const union = unionOf([alias], declared("lib.Alias", { steps: [{ name: "r", invoke: refSentinel("raise") }] }));
    expect(union).toEqual({ codes: ["OTHER"], unbounded: false });
  });

  it("a `base:` child presents what its mapping invokes, resolved in the mapping's module", () => {
    const mapped = definition("Mapped", {
      extends: "lib.Steps",
      schema: { type: "object", properties: {} },
      base: { steps: [{ name: "r", invoke: refSentinel("raise") }] },
    });
    expect(unionOf([mapped], declared("lib.Mapped"))).toEqual({ codes: ["RAISED"], unbounded: false });
  });

  it("a `base:` child forwarding its steps presents the consumer's step codes", () => {
    const forwarding = definition("Forwarding", {
      extends: "lib.Steps",
      schema: { type: "object", properties: { steps: { type: "array" } } },
      base: { steps: cel("self.steps") },
    });
    const union = unionOf(
      [forwarding],
      declared("lib.Forwarding", { steps: [{ name: "r", invoke: refSentinel("raise") }] }),
    );
    expect(union).toEqual({ codes: ["OTHER"], unbounded: false });
  });

  it("an expression a mapping computes at a driven slot makes the union unbounded", () => {
    const computed = definition("Computed", {
      extends: "lib.Steps",
      schema: { type: "object", properties: {} },
      base: { steps: cel("[]") },
    });
    expect(unionOf([computed], declared("lib.Computed")).unbounded).toBe(true);
  });
});

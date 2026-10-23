import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import {
  declaresNameField,
  isInlineDeclaration,
  isResolvedReference,
  resolvedReference,
} from "../src/resolved-reference.js";
import { validateReferenceForms, withoutRefusedFormConsequences } from "../src/validate-reference-forms.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * A value at a reference slot is a reference only when it carries the
 * resolved-reference marker; a `name` decides nothing. `INVALID_REFERENCE_FORM`
 * stays the repair for an author who wrote the removed `{ kind, name }` form —
 * judged by whether the kind declares a `name` field at all.
 */

const definition = (name: string, schema: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    kind: "Telo.Definition",
    metadata: { name, module: "fx" },
    capability: "Telo.Invocable",
    schema,
    ...extra,
  }) as unknown as ResourceDefinition;

const NAMED = definition("Named", {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: { type: "string" } },
});
const OPEN = definition("Open", { type: "object" });
const HOLDER = definition("Holder", {
  type: "object",
  properties: { target: { "x-telo-ref": { kind: "Telo.Invocable", use: "call" } } },
});

function analyze(target: unknown, declared: ResourceManifest[] = []): { code: string; message: string }[] {
  const registry = new AnalysisRegistry();
  registry.registerModuleIdentity("std", "fx");
  registry.registerModuleIdentity("std", "app");
  registry.registerImport("Fx", "fx", ["Named", "Open", "Holder"]);
  for (const def of [NAMED, OPEN, HOLDER]) registry.registerDefinition(def);
  const app = { kind: "Telo.Application", metadata: { name: "App" } } as unknown as ResourceManifest;
  const holder = {
    kind: "Fx.Holder",
    metadata: { name: "holder", module: "app" },
    target,
  } as unknown as ResourceManifest;
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions([app, holder, ...declared]), undefined, registry)
    .filter((d) => d.severity === 1)
    .map((d) => ({ code: d.code as string, message: d.message }));
}

describe("the resolved-reference marker", () => {
  it("is what tells a reference from an inline declaration, never a name", () => {
    expect(isResolvedReference(resolvedReference("fx.Named", "house"))).toBe(true);
    expect(isInlineDeclaration(resolvedReference("fx.Named", "house"))).toBe(false);
    expect(isResolvedReference({ kind: "fx.Named", name: "house" })).toBe(false);
    expect(isInlineDeclaration({ kind: "fx.Named", name: "house" })).toBe(true);
  });

  it("reads a `name` field declared through a local reference, a conjunct or a union branch", () => {
    const none = () => undefined;
    const throughRef = definition("Ref", {
      $ref: "#/$defs/Shape",
      $defs: { Shape: { type: "object", properties: { name: { type: "string" } } } },
    });
    const throughConjunct = definition("Conjunct", {
      type: "object",
      allOf: [{ $ref: "#/$defs/Named" }],
      $defs: { Named: { properties: { name: { type: "string" } } } },
    });
    const throughBranch = definition("Branch", {
      type: "object",
      anyOf: [{ properties: { path: { type: "string" } } }, { properties: { name: { type: "string" } } }],
    });
    const nested = definition("Nested", {
      type: "object",
      properties: { inner: { type: "object", properties: { name: { type: "string" } } } },
    });
    expect(declaresNameField(throughRef, none)).toBe(true);
    expect(declaresNameField(throughConjunct, none)).toBe(true);
    expect(declaresNameField(throughBranch, none)).toBe(true);
    expect(declaresNameField(nested, none)).toBe(false);
  });

  it("reads a `name` field off the author schema folded along extends", () => {
    const resolve = (kind: string) => (kind === "fx.Named" ? NAMED : undefined);
    const merged = definition("Child", { type: "object" }, { extends: "fx.Named" });
    const based = definition("Based", { type: "object" }, { extends: "fx.Named", base: { name: "x" } });
    expect(declaresNameField(merged, resolve)).toBe(true);
    expect(declaresNameField(based, resolve)).toBe(false);
  });
});

describe("an object at a reference slot", () => {
  it("is a declaration of a kind declaring `name`, checked against its schema", () => {
    expect(analyze({ kind: "Fx.Named", name: "house" })).toEqual([]);
    expect(analyze({ kind: "Fx.Named", name: 7 }).map((d) => d.code)).toEqual(["SCHEMA_VIOLATION"]);
  });

  it("is the legacy reference form for a kind whose schema does not declare `name`, open or not", () => {
    const other = { kind: "Fx.Open", metadata: { name: "other", module: "app" } } as unknown as ResourceManifest;
    expect(analyze({ kind: "Fx.Open", name: "other" }, [other])).toEqual([
      {
        code: "INVALID_REFERENCE_FORM",
        message:
          "Fx.Holder/holder: object reference '{ kind, name }' at 'target' is not supported; write it as '!ref other'",
      },
    ]);
  });

  it("is refused when an author writes the marker", () => {
    expect(analyze({ __ref: true, kind: "Fx.Named", name: "house" })).toEqual([
      {
        code: "INVALID_REFERENCE_FORM",
        message:
          "Fx.Holder/holder: '__ref' at 'target' is not supported — it marks a reference the loader resolved; write a reference as '!ref house'",
      },
    ]);
  });
});

describe("normalization", () => {
  function normalized(target: unknown): Record<string, any>[] {
    const registry = new AnalysisRegistry();
    registry.registerModuleIdentity("std", "fx");
    registry.registerModuleIdentity("std", "lib");
    registry.registerImport("Fx", "fx", ["Named", "Open", "Holder"]);
    for (const def of [NAMED, OPEN, HOLDER]) registry.registerDefinition(def);
    const holder = { kind: "Fx.Holder", metadata: { name: "holder", module: "lib" }, target };
    return new StaticAnalyzer().normalize([holder as unknown as ResourceManifest], registry) as never;
  }

  it("reads the legacy `{ kind, name }` of a kind declaring no `name` field as the reference it means", () => {
    const out = normalized({ kind: "Fx.Open", name: "other" });
    expect(out).toHaveLength(1);
    expect(out[0]!.target).toEqual({ __ref: true, kind: "Fx.Open", name: "other" });
  });

  it("extracts the same spelling for a kind declaring `name`", () => {
    const out = normalized({ kind: "Fx.Named", name: "house" });
    expect(out.map((m) => m.metadata.name)).toEqual(["holder", "holder_target"]);
    expect(out[0]!.target).toEqual({ __ref: true, kind: "Fx.Named", name: "holder_target" });
    expect(out[1]!.name).toBe("house");
  });
});

describe("what a refused marker drops", () => {
  it("is what is reported about that declaration, never about a namesake in another module", () => {
    const registry = new AnalysisRegistry();
    registry.registerModuleIdentity("std", "fx");
    registry.registerModuleIdentity("std", "app");
    registry.registerImport("Fx", "fx", ["Named", "Open", "Holder"]);
    for (const def of [NAMED, OPEN, HOLDER]) registry.registerDefinition(def);
    const ours = {
      kind: "Fx.Holder",
      metadata: { name: "holder", module: "app", source: "file:///app/telo.yaml" },
      target: { __ref: true, kind: "Fx.Named", name: "house" },
    } as unknown as ResourceManifest;
    const theirs = {
      kind: "Fx.Holder",
      metadata: { name: "holder", module: "lib", source: "file:///lib/telo.yaml" },
    } as unknown as ResourceManifest;
    const ctx = registry._context();
    const refusals = validateReferenceForms([ours], ctx.definitions!, ctx.aliases, ctx.aliasesByModule);
    const at = (filePath: string) => ({
      severity: 1,
      code: "UNRESOLVED_REFERENCE",
      source: "telo-analyzer",
      message: "unresolved",
      data: { resource: { kind: "Fx.Holder", name: "holder" }, filePath, path: "target" },
    });
    const kept = withoutRefusedFormConsequences(
      [...refusals, at("file:///app/telo.yaml"), at("file:///lib/telo.yaml")] as never,
      [ours, theirs],
    );
    expect(kept.map((d) => [d.code, (d.data as { filePath?: string }).filePath])).toEqual([
      ["INVALID_REFERENCE_FORM", "file:///app/telo.yaml"],
      ["UNRESOLVED_REFERENCE", "file:///lib/telo.yaml"],
    ]);
  });
});

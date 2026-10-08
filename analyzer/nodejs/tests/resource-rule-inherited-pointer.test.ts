import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * A rule's `in:` pointer is judged against the kind's merged schema, wherever
 * the parent that declares the field is registered relative to the child.
 */

const cel = (source: string) => makeTaggedSentinel("cel", source);

const library = {
  kind: "Telo.Library",
  metadata: { name: "Own", source: "own/telo.yaml" },
} as unknown as ResourceManifest;

const dependencyImport = {
  kind: "Telo.Import",
  metadata: { name: "Dep", module: "Own", resolvedModuleName: "Dep", source: "own/telo.yaml" },
  source: "./dep",
} as unknown as ResourceManifest;

const parent = (module: string): ResourceManifest =>
  ({
    kind: "Telo.Definition",
    metadata: { name: "Parent", module, source: `${module.toLowerCase()}/telo.yaml` },
    capability: "Telo.Provider",
    controllers: ["pkg:telo/local/js?path=./x.mjs#Parent"],
    schema: {
      type: "object",
      properties: { entries: { type: "array", items: { type: "object" } } },
    },
  }) as unknown as ResourceManifest;

const child = (extendsKind: string, pointer: string): ResourceManifest =>
  ({
    kind: "Telo.Definition",
    metadata: { name: "Child", module: "Own", source: "own/telo.yaml" },
    capability: "Telo.Provider",
    extends: extendsKind,
    controllers: ["pkg:telo/local/js?path=./x.mjs#Child"],
    schema: {
      type: "object",
      properties: { label: { type: "string" } },
      "x-telo-resource-rules": [
        { in: pointer, condition: cel("has(this.name)"), code: "ENTRY_UNNAMED", message: "has no name." },
      ],
    },
  }) as unknown as ResourceManifest;

const invalid = (docs: ResourceManifest[]) =>
  new StaticAnalyzer()
    .analyze(withSyntheticPositions(docs))
    .filter((d) => d.code === "RESOURCE_RULE_INVALID")
    .map((d) => d.message);

describe("a rule whose `in:` names an inherited field", () => {
  it("is accepted when the parent is declared after the child in the same module", () => {
    expect(invalid([library, child("Self.Parent", "/entries"), parent("Own")])).toEqual([]);
  });

  it("is accepted when the parent is declared by an imported module", () => {
    expect(invalid([library, dependencyImport, child("Dep.Parent", "/entries"), parent("Dep")])).toEqual([]);
  });

  it("is still refused when neither the child nor its parent declares the field", () => {
    for (const docs of [
      [library, child("Self.Parent", "/missing"), parent("Own")],
      [library, dependencyImport, child("Dep.Parent", "/missing"), parent("Dep")],
    ]) {
      expect(invalid(docs)).toEqual([expect.stringContaining("'in' points at '/missing'")]);
    }
  });
});

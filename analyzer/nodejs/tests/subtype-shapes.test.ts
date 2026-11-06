import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResourceManifest } from "@telorun/sdk";
import { StaticAnalyzer } from "../src/analyzer.js";
import { listRequests } from "../src/declaration-requests.js";
import { isTypeKind } from "../src/validate-cel-context.js";
import { loadFile, ROOT } from "./configuration-corpus.js";

/** A kind that inherits `Telo.Type` only through `extends: Telo.JsonSchema` is a named shape everywhere. */
describe("a kind extending Telo.JsonSchema", () => {
  it("is a named shape for contracts, value-schema-from, context-ref-from and slots", async () => {
    const loaded = await loadFile(join(ROOT, "analyzer/nodejs/tests/__fixtures__/subtype-shapes/telo.yaml"));
    const findings = new StaticAnalyzer()
      .analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments })
      .map((d) => `${d.code} ${(d.data as { resource?: { name?: string } } | undefined)?.resource?.name}: ${d.message}`);
    expect(findings).toEqual([
      "SCHEMA_VIOLATION wrong: Kinds.Probe/wrong: `value` does not satisfy the type declared at `/event`: / is missing required property 'email'",
      "SCHEMA_VIOLATION wrong: Kinds.Probe/wrong: `value` does not satisfy the type declared at `/event`: /userId must be string",
      "CEL_UNKNOWN_FIELD local: Telo.Sequence/local: !cel: 'inputs.kye' is not defined (available: userId, email)",
      "CEL_UNKNOWN_FIELD imported: Telo.Sequence/imported: !cel: 'inputs.kye' is not defined (available: userId, email)",
      "CEL_UNKNOWN_FIELD wrong: Kinds.Probe/wrong: !cel: 'payload.nope' is not defined (available: userId, email)",
      "REFERENCE_KIND_MISMATCH refusesPlain: Kinds.Strict/refusesPlain: reference at 'event' → 'Telo.JsonSchema' (resolved: 'Telo.JsonSchema') does not match required 'SubtypeKinds.Event'",
    ]);
  }, 120_000);
});

describe("a named shape's inherited capability", () => {
  const definition = (module: string, name: string, fields: Record<string, unknown>) =>
    ({ kind: "Telo.Definition", metadata: { name, module }, ...fields }) as unknown as ResourceManifest;
  const declarations = listRequests([
    definition("ShapesA", "Shape", { capability: "Telo.Type" }),
    definition("ShapesA", "Gadget", { extends: "Self.Shape" }),
    definition("ShapesB", "Shape", { capability: "Telo.Invocable" }),
    definition("ShapesB", "Widget", { extends: "Self.Shape" }),
    definition("ShapesB", "Thing", { extends: "A.Shape" }),
    {
      kind: "Telo.Import",
      metadata: { name: "A", module: "ShapesB", resolvedModuleName: "ShapesA" },
    } as unknown as ResourceManifest,
  ]);

  it("is read from the parent its extends names in the module that wrote it", () => {
    expect(isTypeKind("ShapesA.Gadget", declarations)).toBe(true);
    expect(isTypeKind("ShapesB.Widget", declarations)).toBe(false);
    expect(isTypeKind("ShapesB.Thing", declarations)).toBe(true);
  });
});

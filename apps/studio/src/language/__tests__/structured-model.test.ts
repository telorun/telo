import { describe, expect, it } from "vitest";
import { refSlotOf, resolveRefCandidates } from "../../components/resource-schema-form/ref-candidates";
import { structuredModelOf } from "../structured-model";
import { analysedApp, studioKinds } from "./view-model-fixture";

/** A slot of `Work.Task` as studio's own schema holds it. */
async function studioSlot(field: string) {
  const kinds = await studioKinds();
  const schema = kinds.get("Work.Task")!.schema as { properties: Record<string, Record<string, unknown>> };
  return { kinds, slot: refSlotOf(schema.properties[field]!)! };
}

const resources = [
  { kind: "Work.Source", name: "words", config: { value: "hello" } },
  { kind: "Work.Count", name: "counter", config: {} },
  { kind: "Work.Task", name: "main", config: {} },
];

describe("structuredModelOf", () => {
  it("offers at a reference slot exactly the resources the analysis offers, withholding one whose output does not fit", async () => {
    const { registry, model } = await analysedApp();
    const { kinds, slot } = await studioSlot("source");
    const engineSlot = refSlotOf(
      (registry.resolveDefinition("Jobs.Task")!.schema as { properties: Record<string, Record<string, unknown>> })
        .properties.source!,
    )!;

    const offered = resolveRefCandidates(slot.kinds, resources, structuredModelOf(model, kinds), slot);
    expect(offered).toEqual(resolveRefCandidates(engineSlot.kinds, resources, registry, engineSlot));
    expect(offered.map((r) => r.name)).toEqual(["counter"]);
    expect(structuredModelOf(model, kinds).userFacingKindsForRef("Jobs.Task")).toEqual(
      registry.userFacingKindsForRef("Jobs.Task"),
    );
  });

  // Studio reads a slot as its author wrote it and the engine after migration,
  // so the two `outputType`s differ; the verdict is found by the slot's place.
  it("finds the verdict of a slot whose outputType the engine reads in a migrated spelling", async () => {
    const { model } = await analysedApp();
    const { kinds, slot } = await studioSlot("sink");
    const offered = resolveRefCandidates(slot.kinds, resources, structuredModelOf(model, kinds), slot);
    expect(offered.map((r) => r.name)).toEqual(["counter"]);
  });

  it("judges a template body's entries by the body's verdicts, never by a module resource of the same name", async () => {
    const { model } = await analysedApp();
    const { kinds, slot } = await studioSlot("source");
    const body = [
      { kind: "Work.Count", name: "words", config: {} },
      { kind: "Work.Source", name: "src", config: { value: "x" } },
    ];
    const scoped = structuredModelOf(model, kinds).forTemplate("Shop.Pipeline");
    expect(resolveRefCandidates(slot.kinds, body, scoped, slot).map((r) => r.name)).toEqual(["words"]);
  });

  it("resolves a written spelling, keeps a canonical kind as itself, and resolves nothing else", async () => {
    const { model } = await analysedApp();
    const structured = structuredModelOf(model, await studioKinds());
    expect(structured.resolveKind("Work.Task")).toBe("Jobs.Task");
    expect(structured.resolveKind("Jobs.Count")).toBe("Jobs.Count");
    expect(structured.resolveKind("Work.Missing")).toBeUndefined();
  });

  it("reads a kind's contract by any spelling, and the module document's schema", async () => {
    const { registry, model } = await analysedApp();
    const structured = structuredModelOf(model, await studioKinds());
    expect(structured.inputTypeForKind("Work.Source")).toEqual(registry.inputTypeForKind("Work.Source"));
    expect(structured.outputTypeForKind("Jobs.Count")).toEqual(registry.outputTypeForKind("Jobs.Count"));
    expect(structured.inputTypeForKind("Work.Task")).toBeUndefined();
    expect(structured.moduleRootSchema()).toEqual(registry.resolveDefinitionIn("Telo.Application")!.schema);
  });
});

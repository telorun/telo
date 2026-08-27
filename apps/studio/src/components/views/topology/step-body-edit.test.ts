import { Loader, type ManifestSource } from "@telorun/analyzer";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { getStepSchema, getVariants, type VariantMeta } from "../../../schema-utils";
import { appendAt, freshStepName, mergeAt, newStep, writeAt } from "./step-body-edit";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");

const diskSource: ManifestSource = {
  supports: () => true,
  read: async (url) => ({ text: await readFile(url, "utf8"), source: url }),
  resolveRelative: (base, relative) => resolve(dirname(base), relative),
};

describe("creating a step", () => {
  let variants: VariantMeta[];

  // Against the REAL `Run.Sequence` schema, for the reason the step-list model
  // test gives: the control-flow vocabulary is a shared manifest fragment, and a
  // hand-written schema would assert against a shape nothing ships.
  beforeAll(async () => {
    const loaded = await new Loader([diskSource]).loadModule(`${repoRoot}/modules/run/telo.yaml`);
    const sequence = loaded.owner.manifests.find(
      (m) =>
        m?.kind === "Telo.Definition" && (m.metadata as { name?: string })?.name === "Sequence",
    ) as Record<string, unknown> | undefined;
    const schema = sequence!.schema as Record<string, unknown>;
    variants = getVariants(getStepSchema(schema)!, schema);
  });

  function variant(title: string): VariantMeta {
    const found = variants.find((v) => v.title === title);
    expect(found, `${title} variant`).toBeDefined();
    return found!;
  }

  // The regression: a control-flow step used to be created with its predicate
  // and WITHOUT its body, which the schema requires beside it — so the step
  // matched no alternative the moment it appeared, and the list renders only
  // bodies that exist, leaving nothing to click to repair it.
  it("seeds the body a control-flow step requires", () => {
    expect(newStep(variant("if/then/else"), "step1")).toEqual({
      name: "step1",
      if: false,
      then: [],
    });
    expect(newStep(variant("while/do"), "step1")).toEqual({
      name: "step1",
      while: false,
      do: [],
    });
    expect(newStep(variant("try/catch/finally"), "step1")).toEqual({ name: "step1", try: [] });
  });

  it("seeds a case map as a map, not a list", () => {
    expect(newStep(variant("switch/cases/default"), "step1")).toEqual({
      name: "step1",
      switch: "",
      cases: {},
    });
  });

  // A reference has no empty value: a blank one is a BROKEN reference rather
  // than an unfinished one, so the target is picked in the step's form.
  it("leaves the invoke target unset", () => {
    const step = newStep(variant("invoke"), "step1");
    expect(step).toEqual({ name: "step1" });
  });

  it("names a step against every name in the body, not just its own branch", () => {
    expect(freshStepName(new Set(["step1", "step2"]))).toBe("step3");
    expect(freshStepName(new Set())).toBe("step1");
  });
});

describe("writing into a body", () => {
  const fields = {
    steps: [{ name: "step1", if: false, then: [{ name: "step2" }], else: [] }],
  };

  it("appends into a nested body without touching its siblings", () => {
    const next = appendAt(fields, "/steps/0/then", { name: "step3" });
    const steps = next.steps as Record<string, unknown>[];
    expect(steps[0].then).toEqual([{ name: "step2" }, { name: "step3" }]);
    // The sibling entry is the SAME object, which is what keeps the field diff
    // pointed at one new index instead of rewriting the array.
    expect((steps[0].then as unknown[])[0]).toBe(
      (fields.steps[0].then as unknown[])[0],
    );
    expect(fields.steps[0].then).toHaveLength(1);
  });

  it("appends into a body that was never written", () => {
    const next = appendAt({ steps: [{ name: "step1", if: false }] }, "/steps/0/then", {
      name: "step2",
    });
    expect((next.steps as Record<string, unknown>[])[0].then).toEqual([{ name: "step2" }]);
  });

  it("creates a body a step does not have", () => {
    const next = writeAt({ steps: [{ name: "step1", if: false, then: [] }] }, "/steps/0/else", []);
    expect((next.steps as Record<string, unknown>[])[0]).toEqual({
      name: "step1",
      if: false,
      then: [],
      else: [],
    });
  });

  // Saying what an unfinished step does must not cost it its name — the name is
  // what makes `steps.<name>.result` reachable — nor its guard or position.
  it("keeps what a step already had when it gains an operation", () => {
    const next = mergeAt(
      { steps: [{ name: "step1", when: true }, { name: "step2" }] },
      "/steps/0",
      { if: false, then: [] },
    );
    const steps = next.steps as Record<string, unknown>[];
    expect(steps[0]).toEqual({ name: "step1", when: true, if: false, then: [] });
    expect(steps[1]).toEqual({ name: "step2" });
  });

  it("takes a case key as written, escapes and all", () => {
    const next = writeAt(
      { steps: [{ name: "step1", switch: "", cases: {} }] },
      "/steps/0/cases/a~1b",
      [],
    );
    const cases = (next.steps as Record<string, unknown>[])[0].cases as Record<string, unknown>;
    expect(cases).toEqual({ "a/b": [] });
  });
});

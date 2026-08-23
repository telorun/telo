import { Loader, type ManifestSource } from "@telorun/analyzer";
import { makeTaggedSentinel } from "@telorun/templating";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { getStepSchema, getVariants, type VariantMeta } from "../../../schema-utils";
import { buildStepList, type StepEntry } from "./step-list-model";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");

const diskSource: ManifestSource = {
  supports: () => true,
  read: async (url) => ({ text: await readFile(url, "utf8"), source: url }),
  resolveRelative: (base, relative) => resolve(dirname(base), relative),
};

/**
 * Read against the REAL `Run.Sequence` schema, for the reason
 * `run-step-schema.test.ts` gives: the control-flow vocabulary this model reads
 * is a shared manifest fragment resolved through the loader, and a hand-written
 * schema would assert against a shape nothing ships.
 */
describe("step list model", () => {
  let schema: Record<string, unknown>;
  let stepSchema: Record<string, unknown>;
  let variants: VariantMeta[];

  beforeAll(async () => {
    const loaded = await new Loader([diskSource]).loadModule(`${repoRoot}/modules/run/telo.yaml`);
    const sequence = loaded.owner.manifests.find(
      (m) =>
        m?.kind === "Telo.Definition" && (m.metadata as { name?: string })?.name === "Sequence",
    ) as Record<string, unknown> | undefined;
    expect(sequence, "Run.Sequence definition").toBeDefined();
    schema = sequence!.schema as Record<string, unknown>;
    stepSchema = getStepSchema(schema)!;
    variants = getVariants(stepSchema, schema);
  });

  function read(steps: unknown[], declared: string[] = []): StepEntry[] {
    return buildStepList({
      steps,
      stepSchema,
      variants,
      root: schema,
      pointer: "/steps",
      declared: new Set(declared),
      signatureOf: () => undefined,
    });
  }

  const ref = (name: string) => makeTaggedSentinel("ref", name);
  const cel = (source: string) => makeTaggedSentinel("cel", source);

  it("reads a dispatch as its target, with the pointers an edit needs", () => {
    const [entry] = read([{ name: "load", invoke: ref("query"), inputs: { id: 1 } }], ["query"]);
    expect(entry).toMatchObject({
      pointer: "/steps/0",
      containerPointer: "/steps",
      index: 0,
      depth: 0,
      stepName: "load",
      target: "query",
      unresolved: false,
      inputKeys: ["id"],
    });
    expect(entry!.branches).toEqual([]);
  });

  it("reports a step naming a resource the module does not declare", () => {
    // A body pointing at nothing is why a run fails, and the row is the only
    // place it is visible in this view.
    const [entry] = read([{ invoke: ref("missing") }]);
    expect(entry).toMatchObject({ target: "missing", unresolved: true });
  });

  it("descends into every branch, each carrying the pointer of its own array", () => {
    const [entry] = read([
      {
        name: "check",
        if: cel("inputs.ok"),
        then: [{ name: "yes", invoke: ref("a") }],
        else: [{ name: "no", invoke: ref("b") }],
      },
    ]);

    expect(entry).toMatchObject({ keyword: "if", when: "inputs.ok" });
    expect(entry!.branches.map((b) => [b.label, b.pointer])).toEqual([
      ["then", "/steps/0/then"],
      ["else", "/steps/0/else"],
    ]);

    const nested = entry!.branches[0]!.entries[0]!;
    expect(nested).toMatchObject({
      pointer: "/steps/0/then/0",
      containerPointer: "/steps/0/then",
      depth: 1,
      stepName: "yes",
    });
  });

  it("labels a case branch by its key and escapes the key into the pointer", () => {
    // A case key is author-written, so a `/` in one would otherwise name a path
    // that is not there — and the edit would land somewhere else entirely.
    const [entry] = read([
      {
        switch: cel("inputs.kind"),
        cases: { "a/b": [{ invoke: ref("x") }] },
      },
    ]);
    expect(entry!.branches.map((b) => [b.label, b.pointer])).toEqual([
      ["cases: a/b", "/steps/0/cases/a~1b"],
    ]);
  });

  it("labels an else-if branch by its own condition", () => {
    // `elseif 1` says nothing a reader wants, and the branches are otherwise
    // indistinguishable from one another.
    const [entry] = read([
      {
        if: cel("a"),
        then: [],
        elseif: [{ if: cel("b"), then: [{ invoke: ref("x") }] }],
      },
    ]);
    const branch = entry!.branches.find((b) => b.pointer.includes("elseif"));
    expect(branch).toMatchObject({
      label: "elseif: b",
      pointer: "/steps/0/elseif/0/then",
    });
    expect(branch!.entries[0]!.depth).toBe(1);
  });

  it("nests to arbitrary depth, since a branch holds steps", () => {
    const [entry] = read([
      {
        while: cel("more"),
        do: [{ try: [{ invoke: ref("x") }], catch: [] }],
      },
    ]);
    const inner = entry!.branches[0]!.entries[0]!;
    expect(inner.keyword).toBe("try");
    expect(inner.branches[0]).toMatchObject({ label: "try", pointer: "/steps/0/do/0/try" });
    expect(inner.branches[0]!.entries[0]).toMatchObject({
      pointer: "/steps/0/do/0/try/0",
      depth: 2,
    });
  });

  it("keeps a step it cannot classify as a row rather than dropping it", () => {
    // It is in the manifest; a list that rendered nothing would be hiding it.
    const [entry] = read([{ nonsense: true }]);
    expect(entry).toMatchObject({ pointer: "/steps/0", unresolved: false });
    expect(entry!.branches).toEqual([]);
  });
});

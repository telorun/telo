import { describe, expect, it } from "vitest";
import { Loader, type ManifestSource } from "@telorun/analyzer";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getVariants } from "./schema-utils.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The editor's local adapter, reduced to what loading one module needs. */
const diskSource: ManifestSource = {
  supports: () => true,
  read: async (url) => ({ text: await readFile(url, "utf8"), source: url }),
  resolveRelative: (base, relative) => resolve(dirname(base), relative),
};

/**
 * The editor renders a `Run` step by reading its schema's `oneOf` branches, and
 * its resolver understands document-local `#/` refs ONLY — anything else throws.
 * So the moment `modules/run/telo.yaml` began pointing its invoke branch at the
 * shared dispatch site, whether the editor still worked came down entirely to
 * whether fragment expansion had run by the time the schema reached it.
 *
 * It had not: expansion was gated on `desugarImports`, and the editor's workspace
 * load passes no options. Every canvas containing a Run.Sequence threw while
 * building its model — with nothing in the analyzer or the manifest to indicate
 * why, because both were correct.
 *
 * This loads the real module the way the editor does — bare, no options — and
 * asserts the branch is readable. It is deliberately not a unit test over a
 * hand-written schema: the regression lived in the seam between how the module
 * declares a step and how the loader was configured, and only the real pair
 * exercises it.
 */
describe("Run step schema reaches the editor resolved", () => {
  it("exposes the invoke variant with its dispatch-site fields", async () => {
    // Bare `loadModule`, exactly as the editor's workspace load calls it.
    const loader = new Loader([diskSource]);
    const loaded = await loader.loadModule(`${repoRoot}/modules/run/telo.yaml`);

    const sequence = loaded.owner.manifests.find(
      (m) => m?.kind === "Telo.Definition" && (m.metadata as { name?: string })?.name === "Sequence",
    ) as Record<string, any> | undefined;
    expect(sequence, "Run.Sequence definition").toBeDefined();

    const stepSchema = sequence!.schema.$defs.step as Record<string, unknown>;
    const variants = getVariants(stepSchema, sequence!.schema);

    const invoke = variants.find((v) => v.title === "invoke");
    expect(invoke, "invoke variant — a throw here is the resolver refusing a shared fragment").toBeDefined();

    // The fields the canvas drives off, all of which live in the fragment.
    expect(Object.keys(invoke!.schema.properties as object)).toEqual(
      expect.arrayContaining(["invoke", "inputs", "when", "retry", "name"]),
    );
    expect(invoke!.invokeField).toBe("invoke");

    // Every other branch still resolves, so the control-flow steps are unaffected.
    expect(variants.map((v) => v.title)).toEqual(
      expect.arrayContaining(["invoke", "if/then/else", "while/do", "switch/cases/default"]),
    );
  });
});

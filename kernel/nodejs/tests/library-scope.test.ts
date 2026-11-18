import { RuntimeError } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { resolveLibraryScope } from "../src/controllers/module/library-scope.js";
import type { BuiltinControllerContext } from "../src/internal-context.js";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";

/** An import's view of a kernel whose load never reached the library — the
 *  path a programmatic load takes. */
function outOfGraphContext(kernel: Kernel): BuiltinControllerContext {
  return {
    moduleContext: {},
    isImportValidatedAtLoad: () => false,
    libraryAnalysisHost: () => kernel.libraryAnalysisHost(),
  } as unknown as BuiltinControllerContext;
}

describe("library scope for a library the load did not reach", () => {
  it("fails with ERR_MANIFEST_VALIDATION_FAILED on the library's own error", async () => {
    const memory = new MemorySource();
    memory.set(
      "broken",
      `kind: Telo.Library
metadata:
  name: Broken
---
kind: Nowhere.Thing
metadata:
  name: thing
`,
    );
    const kernel = new Kernel({ sources: [memory], env: {} });

    const failure = await resolveLibraryScope("memory://broken", "Broken", outOfGraphContext(kernel)).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(RuntimeError);
    expect((failure as RuntimeError).code).toBe("ERR_MANIFEST_VALIDATION_FAILED");
    expect((failure as RuntimeError).message).toContain("Nowhere.Thing");
  });

  it("adds the library's own imports to the kernel registry under its module only", async () => {
    const memory = new MemorySource();
    memory.set(
      "dep",
      `kind: Telo.Library
metadata:
  name: DepModule
---
kind: Telo.Abstract
metadata:
  name: Thing
capability: Telo.Invocable
`,
    );
    memory.set(
      "detached",
      `kind: Telo.Library
metadata:
  name: Detached
imports:
  Dep: memory://dep
`,
    );
    const kernel = new Kernel({ sources: [memory], env: {} });

    const scope = await resolveLibraryScope("memory://detached", "Detached", outOfGraphContext(kernel));

    expect(scope.registry.resolveKind("Dep.Thing")).toBe("DepModule.Thing");
    expect(kernel.getAnalysisRegistry().resolveKind("Dep.Thing")).toBeUndefined();
  });

  it("holds every stamp its author wrote — on a scoped import and on a nested declaration in a branch the import may not take — together", async () => {
    const memory = new MemorySource();
    memory.set("dep", "kind: Telo.Library\nmetadata:\n  name: Dep\n");
    memory.set(
      "stamped",
      `kind: Telo.Library
metadata:
  name: Stamped
variables:
  flag:
    type: boolean
---
kind: Telo.Sequence
metadata:
  name: seq
with:
  - kind: Telo.Import
    metadata:
      name: Inner
      module: Elsewhere
    source: memory://dep
steps:
  - name: answer
    invoke: !if
      if: !cel "variables.flag"
      then:
        kind: Telo.Sequence
        metadata:
          module: Elsewhere
        steps: []
      else:
        kind: Telo.Sequence
        steps: []
`,
    );
    const kernel = new Kernel({ sources: [memory], env: {} });

    const scope = await resolveLibraryScope("memory://stamped", "Stamped", outOfGraphContext(kernel));

    expect(scope.writtenStamps).toEqual([
      expect.stringContaining("Telo.Import/Inner: 'metadata.module' is written by the loader"),
      expect.stringContaining("Telo.Sequence/seq: 'steps[0].invoke.then.metadata.module' is written by the loader"),
    ]);
  });

  it("holds the library's other errors beside its stamps", async () => {
    const memory = new MemorySource();
    memory.set(
      "stamped",
      `kind: Telo.Library
metadata:
  name: Stamped
---
kind: Telo.Sequence
metadata:
  name: seq
  module: Elsewhere
steps:
  - name: answer
    invoke: { kind: Nope.Missing, metadata: { name: gone } }
`,
    );
    const kernel = new Kernel({ sources: [memory], env: {} });

    const scope = await resolveLibraryScope("memory://stamped", "Stamped", outOfGraphContext(kernel));

    expect(scope.writtenStamps).toEqual([
      expect.stringContaining("'metadata.module' is written by the loader"),
      expect.stringContaining("Nope"),
    ]);
  });
});

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
    loadModule: (url: string, options: object) => kernel.loadModule(url, options),
    loadManifests: (url: string) => kernel.loadManifests(url),
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

    const failure = await resolveLibraryScope("memory://broken", outOfGraphContext(kernel)).then(
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

    const scope = await resolveLibraryScope("memory://detached", outOfGraphContext(kernel));

    expect(scope.module).toBe("Detached");
    expect(scope.registry?.resolveKind("Dep.Thing")).toBe("DepModule.Thing");
    expect(kernel.getAnalysisRegistry().resolveKind("Dep.Thing")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";

/** A diamond where `app` imports `shared` directly and through `sub`, at two
 *  versions. Both refs address the same location (`memory://shared`) and differ
 *  only in the version they pin — which is what makes them one module to
 *  reconcile. `sharedHigh`/`sharedLow` set the two versions. */
function diamond(memory: MemorySource, sharedHigh: string, sharedLow: string): void {
  memory.set(
    `shared@${sharedHigh}`,
    `kind: Telo.Library\nmetadata:\n  name: shared\n  version: ${sharedHigh}\n`,
  );
  memory.set(
    `shared@${sharedLow}`,
    `kind: Telo.Library\nmetadata:\n  name: shared\n  version: ${sharedLow}\n`,
  );
  memory.set(
    "sub",
    `kind: Telo.Library
metadata:
  name: sub
  version: 1.0.0
imports:
  SharedLow: memory://shared@${sharedLow}
`,
  );
  memory.set(
    "app",
    `kind: Telo.Application
metadata:
  name: DiamondApp
  version: 1.0.0
imports:
  SharedHigh: memory://shared@${sharedHigh}
  Sub: memory://sub
`,
  );
}

describe("kernel version reconciliation", () => {
  it("hoists a same-major skew and redirects runtime import resolution to the winner", async () => {
    const memory = new MemorySource();
    diamond(memory, "0.2.0", "0.1.0");

    const kernel = new Kernel({ sources: [memory], env: {} });
    await kernel.load("memory://app");

    const graph = kernel.getLoadedGraph();
    expect(graph?.overrides.get("memory://shared@0.1.0/telo.yaml")).toBe(
      "memory://shared@0.2.0/telo.yaml",
    );

    // The runtime seam: the import-controller re-resolves `sub`'s lower-version
    // import through `kernel.resolveImportUrl`, which must land on the winner so
    // it loads the same module the analyzer registered — not a colliding copy.
    expect(kernel.resolveImportUrl("memory://sub/telo.yaml", "memory://shared@0.1.0")).toBe(
      "memory://shared@0.2.0/telo.yaml",
    );

    await kernel.start();
    expect(kernel.exitCode).toBe(0);
  });

  it("rejects an incompatible major mismatch at load", async () => {
    const memory = new MemorySource();
    diamond(memory, "2.0.0", "1.0.0");

    const kernel = new Kernel({ sources: [memory], env: {} });
    await expect(kernel.load("memory://app")).rejects.toThrow(/incompatible major/);
  });
});

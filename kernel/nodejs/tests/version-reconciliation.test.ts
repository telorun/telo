import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";

/** A diamond where `app` imports std/shared directly and through `sub`, at two
 *  versions. `sharedHigh`/`sharedLow` set the two versions. */
function diamond(memory: MemorySource, sharedHigh: string, sharedLow: string): void {
  memory.set(
    "shared-hi",
    `kind: Telo.Library\nmetadata:\n  name: shared\n  namespace: std\n  version: ${sharedHigh}\n`,
  );
  memory.set(
    "shared-lo",
    `kind: Telo.Library\nmetadata:\n  name: shared\n  namespace: std\n  version: ${sharedLow}\n`,
  );
  memory.set(
    "sub",
    `kind: Telo.Library
metadata:
  name: sub
  namespace: std
  version: 1.0.0
imports:
  SharedLow: memory://shared-lo
`,
  );
  memory.set(
    "app",
    `kind: Telo.Application
metadata:
  name: DiamondApp
  version: 1.0.0
imports:
  SharedHigh: memory://shared-hi
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
    expect(graph?.overrides.get("memory://shared-lo/telo.yaml")).toBe(
      "memory://shared-hi/telo.yaml",
    );

    // The runtime seam: the import-controller re-resolves `sub`'s lower-version
    // import through `kernel.resolveImportUrl`, which must land on the winner so
    // it loads the same module the analyzer registered — not a colliding copy.
    expect(kernel.resolveImportUrl("memory://sub/telo.yaml", "memory://shared-lo")).toBe(
      "memory://shared-hi/telo.yaml",
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

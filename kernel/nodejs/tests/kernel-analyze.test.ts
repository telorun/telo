import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";

/** A diamond where `app` imports std/shared directly and through `sub`, at two
 *  versions — the same shape `version-reconciliation.test.ts` loads, here to
 *  check what `analyze()` reports instead of what `load()` does. */
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

describe("Kernel.analyze", () => {
  it("reports a clean manifest as diagnostic-free", async () => {
    const memory = new MemorySource();
    memory.set("app", `kind: Telo.Application\nmetadata:\n  name: CleanApp\n  version: 1.0.0\n`);

    const kernel = new Kernel({ sources: [memory], env: {} });
    expect(await kernel.analyze("memory://app")).toEqual([]);
  });

  it("stops at the parse error instead of analyzing the mangled tree", async () => {
    const memory = new MemorySource();
    memory.set(
      "app",
      `kind: Telo.Application
metadata:
  name: ParseFailApp
  version: 1.0.0
text: "unterminated
`,
    );

    const kernel = new Kernel({ sources: [memory], env: {} });
    const diagnostics = await kernel.analyze("memory://app");

    // The unterminated quote swallows the rest of the doc, so `toJSON()` yields
    // a tree with a stray `text` key. Analyzing it would report a SCHEMA_VIOLATION
    // that exists only because the parse failed — noise on top of the real error.
    expect(diagnostics.map((d) => d.code)).toEqual(["MANIFEST_PARSE_FAILED"]);
    expect(diagnostics[0].severity).toBe("error");
  });

  it("surfaces an incompatible major skew as an error", async () => {
    const memory = new MemorySource();
    diamond(memory, "2.0.0", "1.0.0");

    const kernel = new Kernel({ sources: [memory], env: {} });
    const diagnostics = await kernel.analyze("memory://app");

    // `load()` refuses to boot this graph; `analyze()` must not report it clean.
    const conflict = diagnostics.find((d) => d.code === "MODULE_VERSION_CONFLICT");
    expect(conflict?.severity).toBe("error");
  });

  it("surfaces an ambiguous-source hoist as a warning", async () => {
    const memory = new MemorySource();
    diamond(memory, "0.2.0", "0.2.0");
    // One version, two sources, differing content — the case `load()` logs as a
    // warning and keeps booting on.
    memory.set(
      "shared-lo",
      `kind: Telo.Library\nmetadata:\n  name: shared\n  namespace: std\n  version: 0.2.0\n# a differing copy\n`,
    );

    const kernel = new Kernel({ sources: [memory], env: {} });
    const diagnostics = await kernel.analyze("memory://app");

    const hoist = diagnostics.find((d) => d.code === "MODULE_VERSION_HOISTED");
    expect(hoist?.severity).toBe("warning");
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("leaves the kernel untouched, so a later load() is unaffected", async () => {
    const memory = new MemorySource();
    memory.set("app", `kind: Telo.Application\nmetadata:\n  name: CleanApp\n  version: 1.0.0\n`);
    memory.set("other", `kind: Telo.Application\nmetadata:\n  name: OtherApp\n  version: 1.0.0\n`);

    const kernel = new Kernel({ sources: [memory], env: {} });
    await kernel.analyze("memory://other");
    await kernel.load("memory://app");
    await kernel.start();

    expect(kernel.exitCode).toBe(0);
  });
});
